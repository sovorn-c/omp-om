import {
	sessionEntryToContextMessages,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionBeforeCompactEvent,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";

import { resolveCompactionMaxRetainedTokens, resolveCompactionSummaryMaxTokens } from "../config.js";
import { estimateStringTokens } from "../tokens.js";
import { debugLog, withDebugLogContext, type DebugLogContext } from "../debug-log.js";
import type { OmpExtensionContext, Runtime } from "../runtime.js";
import { catchUpObserver } from "./compaction-catch-up.js";
import {
	OM_OBSERVATIONS_RECORDED,
	buildCompactionProjection,
	compactionRangeStartIndex,
	entryIndexForId,
	latestCoverageIndex,
	latestCoverageMarkerId,
	rawTokensAfterIndex,
	describeUnobservedSpan,
	renderFallbackSummary,
	renderSummaryWithBudget,
	unobservedSourceSpanBefore,
	type Entry,
	type MemoryDetails,
	type UnobservedSourceSpan,
} from "../session-ledger/index.js";

/** Bound hook work below omp's 30s handler timeout so native fallback can run. */
export const HOOK_CATCH_UP_DEADLINE_MS = 20_000;

const DEFAULT_OBSERVATIONS_POOL_MAX_TOKENS = 20_000;

function observationsPoolMaxTokens(runtime: Runtime): number {
	const value = (runtime.config as { observationsPoolMaxTokens?: unknown }).observationsPoolMaxTokens;
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: DEFAULT_OBSERVATIONS_POOL_MAX_TOKENS;
}

/**
 * Context-visible message roles Pi accepts as a compaction cut point (mirrors
 * Pi's `isCutPointMessage`): never a tool result, which must follow its call.
 * Cutting at an assistant message keeps its tool results with it.
 */
const CUT_POINT_ROLES = new Set(["user", "assistant", "bashExecution", "custom", "branchSummary", "compactionSummary"]);

function isCutPointEntry(entry: Entry): boolean {
	if (entry.type === "compaction") return false;
	try {
		return sessionEntryToContextMessages(entry as unknown as SessionEntry).some((message) => CUT_POINT_ROLES.has(message.role));
	} catch {
		return false;
	}
}

/** Nearest valid cut point at or before `index`, not before `startIndex`; -1 when none. */
function findCutPointAtOrBefore(entries: Entry[], index: number, startIndex: number): number {
	for (let i = Math.min(index, entries.length - 1); i >= startIndex && i >= 0; i--) {
		if (isCutPointEntry(entries[i])) return i;
	}
	return -1;
}

export type CompactionCut = {
	/** First entry Pi keeps in context. */
	firstKeptEntryId: string;
	/** Entry through which the memory ledger is folded into the rendered summary. */
	foldThroughEntryId: string;
};

export type CompactionCutResolution =
	| { kind: "cut"; cut: CompactionCut; gap?: UnobservedSourceSpan; retainedTokens?: number }
	| { kind: "fallback"; cut: CompactionCut; reason: string; gap: UnobservedSourceSpan };

/**
 * Decide where this compaction cuts.
 *
 * Pi proposes `firstKeptEntryId` from its own `keepRecentTokens` budget. The
 * observer may not have reached that point yet: every source entry between the
 * observation frontier and Pi's cut would then be discarded with no memory
 * describing it. When that happens, retain those entries by moving the
 * boundary back to the nearest valid cut point at or before the first
 * unobserved entry (the entry itself, or the assistant message whose tool
 * result it is), and fold every recorded observation into the summary (a
 * retained source that is also described by an observation is redundant,
 * never lost). If retaining is not possible, or exceeds the retained-tail
 * budget, resolve to `fallback`: Pi's own cut, with the unobserved span
 * reported so the caller can describe it in a model-free summary.
 */
export function resolveCompactionCut(
	entries: Entry[],
	firstKeptEntryId: string,
	options: { maxRetainedTokens: number },
): CompactionCutResolution {
	const piCut: CompactionCut = { firstKeptEntryId, foldThroughEntryId: firstKeptEntryId };
	const cutIndex = entryIndexForId(entries, firstKeptEntryId);
	if (cutIndex === -1) return { kind: "cut", cut: piCut };

	const gap = unobservedSourceSpanBefore(entries, cutIndex);
	if (!gap) return { kind: "cut", cut: piCut };

	const coverageMarkerId = latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED);
	if (!coverageMarkerId) return { kind: "fallback", cut: piCut, reason: "no observation coverage", gap };

	// Only source the observer has covered inside the current compaction range
	// can be folded. Compare source tokens, not indices: Pi's retention
	// boundary may sit on a metadata entry (memory ledger rows carry no context
	// tokens), and cutting one entry past it would free nothing while writing a
	// new compaction entry every time Pi's threshold fires.
	const rangeStart = compactionRangeStartIndex(entries);
	const coverageIndex = latestCoverageIndex(entries, OM_OBSERVATIONS_RECORDED);
	const nothingObserved = { kind: "fallback", cut: piCut, reason: "nothing observed can be compacted", gap } as const;
	if (coverageIndex < rangeStart) return nothingObserved;

	const safeCutIndex = findCutPointAtOrBefore(entries, gap.firstIndex, rangeStart);
	if (safeCutIndex <= rangeStart) return nothingObserved;
	const freedTokens = rawTokensAfterIndex(entries, rangeStart - 1) - rawTokensAfterIndex(entries, safeCutIndex - 1);
	if (freedTokens <= 0) return nothingObserved;

	const retainedTokens = rawTokensAfterIndex(entries, safeCutIndex - 1);
	if (retainedTokens > options.maxRetainedTokens) {
		return {
			kind: "fallback",
			cut: piCut,
			reason: `retaining ~${retainedTokens.toLocaleString()} tokens exceeds the ~${options.maxRetainedTokens.toLocaleString()}-token budget`,
			gap,
		};
	}

	return {
		kind: "cut",
		cut: { firstKeptEntryId: entries[safeCutIndex].id, foldThroughEntryId: coverageMarkerId },
		gap,
		retainedTokens,
	};
}

function warn(ctx: OmpExtensionContext, message: string): void {
	notify(ctx, message, "warning");
}

/** Show a message when the session has a UI. A failing UI must never fail the compaction. */
function notify(ctx: OmpExtensionContext, message: string, level: "info" | "warning"): void {
	if (!ctx.hasUI) return;
	try {
		ctx.ui.notify(message, level);
	} catch {
		// Best-effort.
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function debugContext(runtime: Runtime, ctx: ExtensionContext): DebugLogContext {
	let sessionId: string | undefined;
	let sessionFile: string | undefined;
	try {
		const manager = ctx.sessionManager as { getSessionId?: () => string; getSessionFile?: () => string | undefined } | undefined;
		sessionId = manager?.getSessionId?.();
		sessionFile = manager?.getSessionFile?.();
	} catch {
		// Debug metadata is best-effort.
	}
	return {
		enabled: runtime.config.debugLog === true,
		cwd: ctx.cwd,
		sessionId,
		sessionFile,
		runId: `compaction-${Date.now().toString(36)}`,
	};
}

type HookResult =
	| { compaction: { summary: string; firstKeptEntryId: string; tokensBefore: number; details?: MemoryDetails } }
	| { cancel: true }
	| undefined;

function delegateCompaction(ctx: OmpExtensionContext, runtime: Runtime, reason: string): undefined {
	runtime.memoryFailureReason = reason;
	warn(ctx, `Observational memory: ${reason}. Memory updates are unavailable; using omp's normal compaction.`);
	return undefined;
}

async function withCompactionDeadline(
	signal: AbortSignal | undefined,
	ctx: OmpExtensionContext,
	runtime: Runtime,
	work: (signal: AbortSignal) => Promise<HookResult>,
): Promise<HookResult> {
	const controller = new AbortController();
	// The published ES2022 target does not expose Promise.withResolvers.
	let interrupt!: (result: HookResult) => void;
	const interrupted = new Promise<HookResult>((resolve) => { interrupt = resolve; });
	const onAbort = () => {
		interrupt({ cancel: true });
		controller.abort();
	};
	const timer = setTimeout(() => {
		if (signal?.aborted) { onAbort(); return; }
		interrupt(delegateCompaction(ctx, runtime, `memory work reached the ${HOOK_CATCH_UP_DEADLINE_MS / 1000}s hook deadline`));
		controller.abort();
	}, HOOK_CATCH_UP_DEADLINE_MS);
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		if (signal?.aborted) { onAbort(); return { cancel: true }; }
		return await Promise.race([interrupted, work(controller.signal)]);
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}

async function handleCompaction(pi: ExtensionAPI, event: SessionBeforeCompactEvent, ctx: OmpExtensionContext, runtime: Runtime): Promise<HookResult> {
	if (runtime.memoryFailureReason) return delegateCompaction(ctx, runtime, runtime.memoryFailureReason);
	const resolved = await runtime.resolveModel(ctx);
	if (event.signal?.aborted) return { cancel: true };
	if (!resolved.ok) return delegateCompaction(ctx, runtime, `memory model unavailable: ${resolved.reason}`);
	if (runtime.memoryFailureReason) return delegateCompaction(ctx, runtime, runtime.memoryFailureReason);
	const { preparation, branchEntries } = event;
	const { firstKeptEntryId, tokensBefore } = preparation;
	let entries = branchEntries as Entry[];
	const contextWindow = typeof ctx.model?.contextWindow === "number" ? ctx.model.contextWindow : undefined;
	const maxRetainedTokens = resolveCompactionMaxRetainedTokens(runtime.config, contextWindow);
	const summaryMaxTokens = resolveCompactionSummaryMaxTokens(runtime.config, contextWindow);
	const poolMaxTokens = observationsPoolMaxTokens(runtime);
	let resolution = resolveCompactionCut(entries, firstKeptEntryId, { maxRetainedTokens });

	// The background observer is behind Pi's cut. Rather than retaining the
	// tail or compacting blind, observe the gap now: Pi waits for this hook,
	// so the memory model has the server to itself, and observations are
	// durable. This runs with or without a prior coverage marker.
	if (
		resolution.gap
		&& runtime.config.compactionCatchUpMaxChunks > 0
		&& !runtime.consolidationInFlight
	) {
		const catchUp = await catchUpObserver({ pi, runtime, ctx, entries, gap: resolution.gap, resolved, maxChunks: runtime.config.compactionCatchUpMaxChunks, signal: event.signal });
		if (event.signal?.aborted) return { cancel: true };
		debugLog("compaction.catch_up", { ...catchUp, gapEntries: resolution.gap.entryCount, gapTokens: resolution.gap.tokens });
		if (catchUp.stoppedBecause === "error") {
			return delegateCompaction(ctx, runtime, `observer catch-up failed: ${catchUp.reason ?? "unknown error"}`);
		}
		// Completed chunks are durable; re-read the branch before resolving the cut.
		entries = ctx.sessionManager.getBranch() as Entry[];
		resolution = resolveCompactionCut(entries, firstKeptEntryId, { maxRetainedTokens });
	}

	const summaryOptions = { maxTokens: summaryMaxTokens, observationsPoolMaxTokens: poolMaxTokens };
	let fallback = resolution.kind === "fallback" ? resolution : undefined;
	let cut = resolution.cut;
	let projection = buildCompactionProjection(entries, cut.foldThroughEntryId, { observationsPoolMaxTokens: poolMaxTokens });
	let summary = "";

	if (resolution.kind === "cut") {
		const rendered = renderSummaryWithBudget(projection.reflections, projection.observations, { maxTokens: summaryMaxTokens });
		summary = rendered.text;
		// A summary that kept no record would replace older context with only
		// instructions and an omission notice; render the truncating model-free
		// summary instead (it also covers an empty ledger).
		if (rendered.reflections.length + rendered.observations.length === 0) {
			if (projection.reflections.length + projection.observations.length > 0) {
				debugLog("compaction.summary_budget_empty", {
					summaryMaxTokens,
					reflections: projection.reflections.length,
					observations: projection.observations.length,
				});
				warn(ctx, `Observational memory: no memory record fits the ~${summaryMaxTokens.toLocaleString()}-token summary budget; using a truncated model-free summary`);
			}
			summary = renderFallbackSummary(entries, cut.foldThroughEntryId, summaryOptions);
		}

		// A moved cut keeps the unobserved tail AND adds the rendered memory on
		// top of it. Both must fit the budget, or Pi's threshold fires again
		// right after this compaction. Otherwise use Pi's cut.
		if (resolution.gap && resolution.retainedTokens !== undefined) {
			const summaryTokens = estimateStringTokens(summary);
			if (resolution.retainedTokens + summaryTokens > maxRetainedTokens) {
				fallback = {
					kind: "fallback",
					cut: { firstKeptEntryId, foldThroughEntryId: firstKeptEntryId },
					gap: resolution.gap,
					reason: `retaining ~${resolution.retainedTokens.toLocaleString()} tokens plus a ~${summaryTokens.toLocaleString()}-token memory summary exceeds the ~${maxRetainedTokens.toLocaleString()}-token budget`,
				};
				cut = fallback.cut;
				projection = buildCompactionProjection(entries, cut.foldThroughEntryId, { observationsPoolMaxTokens: poolMaxTokens });
			}
		}
	}

	if (fallback) {
		summary = renderFallbackSummary(entries, cut.foldThroughEntryId, summaryOptions);
		warn(
			ctx,
			`Observational memory: observer has not reached ${describeUnobservedSpan(fallback.gap)} before the compaction cut and they cannot be retained (${fallback.reason}); compacting with a model-free summary of the memory so far`,
		);
	}

	const gap = resolution.gap;
	if (gap) {
		debugLog("compaction.observer_behind", {
			proposedFirstKeptEntryId: firstKeptEntryId,
			unobservedEntries: gap.entryCount,
			unobservedTokens: gap.tokens,
			outcome: fallback ? "fallback" : "cut",
			firstKeptEntryId: cut.firstKeptEntryId,
			foldThroughEntryId: cut.foldThroughEntryId,
			summaryTokens: estimateStringTokens(summary),
			maxRetainedTokens,
			...(fallback ? { reason: fallback.reason } : { retainedTokens: resolution.kind === "cut" ? resolution.retainedTokens : undefined }),
		});
		if (!fallback) {
			notify(
				ctx,
				`Observational memory: observer has not reached ${describeUnobservedSpan(gap)} before the compaction cut; keeping them in context until they are observed`,
				"info",
			);
		}
	}

	return {
		compaction: {
			summary,
			firstKeptEntryId: cut.firstKeptEntryId,
			tokensBefore,
			details: projection.details,
		},
	};
}

function compactAfterFailure(event: SessionBeforeCompactEvent, ctx: OmpExtensionContext, runtime: Runtime, error: unknown): HookResult {
	if (event.signal?.aborted) return { cancel: true };
	return delegateCompaction(ctx, runtime, `compaction hook failed: ${errorMessage(error)}`);
}

export function registerCompactionHook(pi: ExtensionAPI, runtime: Runtime): void {
	pi.on("session_before_compact", async (event: SessionBeforeCompactEvent, ctx: OmpExtensionContext): Promise<HookResult> => {
		if (runtime.compactHookInFlight) {
			warn(ctx, "Observational memory: another compaction is already in progress; cancelling duplicate");
			return { cancel: true };
		}
		if (event.signal?.aborted) return { cancel: true };

		runtime.compactHookInFlight = true;
		try {
			runtime.ensureConfig(ctx.cwd);
			return await withCompactionDeadline(event.signal, ctx, runtime, (signal) =>
				withDebugLogContext(debugContext(runtime, ctx), () => handleCompaction(pi, { ...event, signal }, ctx, runtime)),
			);
		} catch (error) {
			return compactAfterFailure(event, ctx, runtime, error);
		} finally {
			runtime.compactHookInFlight = false;
		}
	});
}

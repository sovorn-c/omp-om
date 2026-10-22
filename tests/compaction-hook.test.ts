import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";

import { registerCompactionHook } from "../src/hooks/compaction-hook.js";
import type { OmpExtensionContext, Runtime } from "../src/runtime.js";
import type { MemoryDetails } from "../src/session-ledger/index.js";
import {
	compactionEntry,
	memoryDetails,
	observation,
	observationsDroppedEntry,
	observationsRecordedEntry,
	oldV2CompactionDetails,
	oldV2ObservationEntry,
	reflection,
	reflectionsRecordedEntry,
	textCustomMessage,
	type TestEntry,
} from "./fixtures/session.js";

type HookResult = {
	compaction?: { summary: string; firstKeptEntryId: string; tokensBefore: number; details?: MemoryDetails };
	cancel?: boolean;
} | undefined;

function setup(args: { entries: TestEntry[]; observationsPoolMaxTokens?: number; compactHookInFlight?: boolean }) {
	let handler: ((event: SessionBeforeCompactEvent, ctx: OmpExtensionContext) => Promise<HookResult>) | undefined;
	const pi = {
		on: vi.fn((_eventName: string, cb: typeof handler) => { handler = cb; }),
		appendEntry: vi.fn(),
	};
	const runtime = {
		config: { observationsPoolMaxTokens: args.observationsPoolMaxTokens ?? 20_000 },
		compactHookInFlight: args.compactHookInFlight ?? false,
		consolidationInFlight: true,
		consolidationPromise: new Promise<void>(() => {}),
		memoryFailureReason: "background model unavailable",
		resolveModel: vi.fn(() => new Promise<never>(() => {})),
		ensureConfig: vi.fn(),
	};
	// Fixtures implement the registration and runtime surfaces the hook consumes.
	const extension = pi as unknown as ExtensionAPI;
	const hookRuntime = runtime as unknown as Runtime;
	registerCompactionHook(extension, hookRuntime);
	if (!handler) throw new Error("compaction handler was not registered");
	const compact = handler;
	const ctx = {
		cwd: "/tmp/project",
		hasUI: true,
		ui: { notify: vi.fn() },
		sessionManager: { getBranch: vi.fn(() => { throw new Error("must use event snapshot"); }) },
	};
	// Only preparation, branch entries and cancellation are relevant to these scenarios.
	const context = ctx as unknown as OmpExtensionContext;
	const run = (firstKeptEntryId = args.entries.at(-1)?.id ?? "missing") => {
		const event = { preparation: { firstKeptEntryId, tokensBefore: 123 }, branchEntries: args.entries } as unknown as SessionBeforeCompactEvent;
		return compact(event, context);
	};
	return { pi, runtime, ctx, run };
}

function replacement(result: HookResult) {
	if (!result?.compaction) throw new Error("expected memory compaction");
	return result.compaction;
}

describe("V3 compaction hook", () => {
	it("declines ownership when there is no V3 memory", async () => {
		const { run, runtime, pi } = setup({ entries: [textCustomMessage("raw-1", "aaaa")] });
		await expect(run("raw-1")).resolves.toBeUndefined();
		expect(runtime.resolveModel).not.toHaveBeenCalled();
		expect(pi.appendEntry).not.toHaveBeenCalled();
		expect(runtime.compactHookInFlight).toBe(false);
	});

	it("renders the existing snapshot without waiting for workers or model resolution, keeping omp's cut", async () => {
		const obs = observation("aaaaaaaaaaaa", { sourceEntryIds: ["raw-1"], tokenCount: 10 });
		const entries = [
			textCustomMessage("raw-1", "observed source"),
			observationsRecordedEntry("om-obs", { observations: [obs], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "unobserved source before the cut"),
			textCustomMessage("raw-3", "retained tail"),
		];
		const { run, runtime, ctx } = setup({ entries });
		const result = replacement(await run("raw-3"));
		expect(result.firstKeptEntryId).toBe("raw-3");
		expect(result.tokensBefore).toBe(123);
		expect(result.details?.observations).toEqual([obs]);
		expect(result.summary).toContain(obs.content);
		expect(runtime.resolveModel).not.toHaveBeenCalled();
		expect(ctx.sessionManager.getBranch).not.toHaveBeenCalled();
	});

	it("first normal compaction writes observations without orphan reflections", async () => {
		const obs = observation("aaaaaaaaaaaa", { sourceEntryIds: ["raw-1"], tokenCount: 10 });
		const ref = reflection("eeeeeeeeeeee", [obs.id]);
		const { run } = setup({ entries: [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-obs", { observations: [obs], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-ref", { reflections: [ref], coversUpToId: "raw-1" }),
		], observationsPoolMaxTokens: 100 });
		const result = replacement(await run("raw-1"));
		expect(result.details).toMatchObject({ fullFold: false, observations: [obs], reflections: [] });
		expect(result.summary).toContain(obs.content);
		expect(result.summary).not.toContain(`[${ref.id}]`);
	});

	it.each([false, true])("applies new maintenance only on a full fold (fullFold=%s)", async (fullFold) => {
		const obs1 = observation("aaaaaaaaaaaa", { tokenCount: 80 });
		const obs2 = observation("bbbbbbbbbbbb", { tokenCount: 30 });
		const ref1 = reflection("eeeeeeeeeeee", [obs1.id]);
		const ref2 = reflection("ffffffffffff", [obs2.id]);
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-obs-1", { observations: [obs1], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-ref-1", { reflections: [ref1], coversUpToId: "raw-1" }),
			compactionEntry("cmp-full", { firstKeptEntryId: "raw-1", details: memoryDetails({ fullFold: true, observations: [obs1], reflections: [ref1] }) }),
			textCustomMessage("raw-2", "bbbb"),
			observationsRecordedEntry("om-obs-2", { observations: [obs2], coversUpToId: "raw-2" }),
			reflectionsRecordedEntry("om-ref-2", { reflections: [ref2], coversUpToId: "raw-2" }),
			observationsDroppedEntry("om-drop", { observationIds: [obs1.id], coversUpToId: "raw-2" }),
		];
		const { run } = setup({ entries, observationsPoolMaxTokens: fullFold ? 100 : 1000 });
		const result = replacement(await run("raw-2"));
		expect(result.details).toMatchObject({
			fullFold,
			observations: fullFold ? [obs2] : [obs1, obs2],
			reflections: fullFold ? [ref1, ref2] : [ref1],
		});
		expect(result.summary).toContain(`[${ref1.id}]`);
		if (fullFold) expect(result.summary).toContain(`[${ref2.id}]`);
		else expect(result.summary).not.toContain(`[${ref2.id}]`);
	});

	it("declines ownership when only old V2 memory exists", async () => {
		const { run } = setup({ entries: [
			textCustomMessage("raw-1", "aaaa"),
			oldV2ObservationEntry("v2-obs"),
			compactionEntry("cmp-v2", { firstKeptEntryId: "raw-1", details: oldV2CompactionDetails() }),
		] });
		await expect(run("cmp-v2")).resolves.toBeUndefined();
	});

	it("cancels a duplicate compaction", async () => {
		const { run, ctx } = setup({ entries: [], compactHookInFlight: true });
		await expect(run()).resolves.toEqual({ cancel: true });
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "warning");
	});
});

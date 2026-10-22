import { entryIndexForId, isSourceEntry, unobservedSourceSpanBefore, type UnobservedSourceSpan } from "./progress.js";
import { buildCompactionProjection } from "./projection.js";
import type { Entry, Observation, Reflection } from "./types.js";

const CONTEXT_USAGE_INSTRUCTIONS = `These are condensed memories from earlier in this session.

- Reflections: stable, long-lived facts about the user, project, decisions, and constraints. New reflection lines may include ids in brackets.
- Observations: timestamped events from the conversation history, in chronological order. Observation lines include ids in brackets.

Treat these as past records. When entries conflict, the most recent observation reflects the latest known state. Work that prior observations describe as completed should not be redone unless the user explicitly asks to revisit it.

When exact source context is needed for precision or traceability, use the om_recall tool with the relevant observation or reflection id. This is especially useful when a reflection materially affects a decision or is too compressed to continue confidently. Do not use om_recall as broad search or inject raw source unless it is needed.`;

export function observationToSummaryLine(observation: Observation): string {
	return `[${observation.id}] ${observation.timestamp} [${observation.relevance}] ${observation.content}`;
}

export function reflectionToSummaryLine(reflection: Reflection): string {
	return `[${reflection.id}] ${reflection.content}`;
}

export type RenderSummaryOptions = {
	/**
	 * Estimated token budget for the rendered summary. Observations are
	 * guaranteed at least half of it (newest first); reflections take the rest
	 * (newest first), and whatever either side leaves unused goes to the other.
	 * Omitted records stay in the session ledger and remain visible through
	 * `/om:view full`.
	 */
	maxTokens?: number;
};

/** Share of the summary budget reserved for observations before reflections are allocated. */
export const SUMMARY_OBSERVATIONS_MIN_SHARE = 0.5;

export type RenderedSummary = {
	text: string;
	reflections: Reflection[];
	observations: Observation[];
	omittedReflections: number;
	omittedObservations: number;
};

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/** Newest-first selection of records whose rendered lines fit `budget`, returned in original order. */
function selectWithinBudget<T>(records: T[], line: (record: T) => string, budget: number): { kept: T[]; tokens: number } {
	const keptIndexes: number[] = [];
	let tokens = 0;
	for (let i = records.length - 1; i >= 0; i--) {
		const cost = estimateTokens(line(records[i])) + 1;
		// Skip a record that does not fit instead of stopping: a single long
		// newest record must not hide shorter older ones that still fit.
		if (tokens + cost > budget) continue;
		tokens += cost;
		keptIndexes.push(i);
	}
	keptIndexes.reverse();
	return { kept: keptIndexes.map((i) => records[i]), tokens };
}

export function renderSummaryWithBudget(
	reflections: Reflection[],
	observations: Observation[],
	options: RenderSummaryOptions = {},
): RenderedSummary {
	if (reflections.length === 0 && observations.length === 0) {
		return { text: "", reflections: [], observations: [], omittedReflections: 0, omittedObservations: 0 };
	}

	let keptReflections = reflections;
	let keptObservations = observations;
	const maxTokens = options.maxTokens;
	if (maxTokens !== undefined && Number.isFinite(maxTokens) && maxTokens > 0) {
		const fixed = estimateTokens(CONTEXT_USAGE_INSTRUCTIONS) + estimateTokens("## Reflections\n## Observations\n\n\n\n") + 40;
		const budget = Math.max(0, maxTokens - fixed);
		// Observations are the chronological record and must not be crowded out
		// by verbose reflections: reserve them a share first, give reflections
		// the remainder, then let observations reclaim whatever reflections left.
		const reserved = selectWithinBudget(observations, observationToSummaryLine, Math.floor(budget * SUMMARY_OBSERVATIONS_MIN_SHARE));
		const pickedReflections = selectWithinBudget(reflections, reflectionToSummaryLine, budget - reserved.tokens);
		keptReflections = pickedReflections.kept;
		keptObservations = selectWithinBudget(observations, observationToSummaryLine, budget - pickedReflections.tokens).kept;
	}

	const omittedReflections = reflections.length - keptReflections.length;
	const omittedObservations = observations.length - keptObservations.length;
	const parts: string[] = [CONTEXT_USAGE_INSTRUCTIONS];
	if (keptReflections.length > 0) {
		parts.push(`## Reflections\n${keptReflections.map(reflectionToSummaryLine).join("\n")}`);
	}
	if (keptObservations.length > 0) {
		parts.push(`## Observations\n${keptObservations.map(observationToSummaryLine).join("\n")}`);
	}
	if (omittedReflections > 0 || omittedObservations > 0) {
		const omitted: string[] = [];
		if (omittedReflections > 0) omitted.push(`${omittedReflections} older reflection${omittedReflections === 1 ? "" : "s"}`);
		if (omittedObservations > 0) omitted.push(`${omittedObservations} older observation${omittedObservations === 1 ? "" : "s"}`);
		parts.push(`(${omitted.join(" and ")} omitted to fit the summary budget; they remain in the session memory ledger, see /om:view full.)`);
	}
	return {
		text: parts.join("\n\n"),
		reflections: keptReflections,
		observations: keptObservations,
		omittedReflections,
		omittedObservations,
	};
}

export function renderSummary(reflections: Reflection[], observations: Observation[], options: RenderSummaryOptions = {}): string {
	return renderSummaryWithBudget(reflections, observations, options).text;
}

/** Fixed model-free fallback text used when no memory record exists. */
export const NO_MEMORY_NOTICE =
	"No observational memory was recorded for this session before this compaction; the earlier context is not summarized.";

const FALLBACK_HEADER = "Observational memory (model-free fallback summary; no memory model was used).";
const EXCERPT_MAX_CHARS = 200;
/** The newest unobserved human message usually carries the current task, so it keeps far more text. */
const LATEST_EXCERPT_MAX_CHARS = 6000;
/** Share of the space left after the fixed text that unobserved excerpts may take. */
const FALLBACK_EXCERPT_SHARE = 0.4;
const OMITTED_EXCERPTS_NOTE_TOKENS = 12;
/** Records are never truncated below this many tokens unless the whole section budget is smaller. */
const MIN_TRUNCATED_RECORD_TOKENS = 16;

export function describeUnobservedSpan(span: UnobservedSourceSpan): string {
	return `${span.entryCount} source entr${span.entryCount === 1 ? "y" : "ies"} (~${span.tokens.toLocaleString()} tokens)`;
}

/** Cost of one block in a `\n\n`-joined summary. */
function blockTokens(text: string): number {
	return estimateTokens(text) + 1;
}

function truncateToTokens(text: string, tokens: number): string {
	if (estimateTokens(text) <= tokens) return text;
	return `${text.slice(0, Math.max(0, tokens * 4 - 1)).trimEnd()}…`;
}

/**
 * Newest-first selection of record lines that fit `budget`, returned in original
 * order. A line is first capped at half the budget so one oversized record is
 * truncated into the summary instead of crowding out, or being dropped for,
 * the rest.
 */
function selectTruncatedLines<T>(records: T[], line: (record: T) => string, budget: number): { lines: string[]; tokens: number } {
	const cap = Math.min(budget, Math.max(MIN_TRUNCATED_RECORD_TOKENS, Math.floor(budget / 2)));
	const picked: string[] = [];
	let tokens = 0;
	if (cap <= 0) return { lines: picked, tokens };
	for (let i = records.length - 1; i >= 0; i--) {
		const text = truncateToTokens(line(records[i]), cap);
		const cost = blockTokens(text);
		if (tokens + cost > budget) continue;
		tokens += cost;
		picked.push(text);
	}
	return { lines: picked.reverse(), tokens };
}

function textOfContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const texts: string[] = [];
	for (const block of content) {
		if (typeof block === "object" && block !== null && "type" in block && block.type === "text" && "text" in block && typeof block.text === "string") {
			texts.push(block.text);
		}
	}
	return texts.join(" ");
}

/** Human-authored text of a source entry (user message, custom message, branch summary), or undefined. */
function entryExcerptSource(entry: Entry): string | undefined {
	if (entry.type === "message") {
		const message = entry.message;
		if (typeof message === "object" && message !== null && "role" in message && message.role === "user" && "content" in message) {
			return textOfContent(message.content);
		}
		return undefined;
	}
	if (entry.type === "custom_message") return textOfContent(entry.content);
	if (entry.type === "branch_summary") return typeof entry.summary === "string" ? entry.summary : undefined;
	return undefined;
}

function excerptOf(text: string, maxChars = EXCERPT_MAX_CHARS): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > maxChars ? `${flat.slice(0, maxChars).trimEnd()}…` : flat;
}

function pickNewestExcerpts(lines: string[], budget: number): string[] {
	const picked: string[] = [];
	let tokens = 0;
	for (let i = lines.length - 1; i >= 0; i--) {
		const cost = estimateTokens(lines[i]) + 1;
		if (tokens + cost > budget) break;
		tokens += cost;
		picked.push(lines[i]);
	}
	return picked.reverse();
}

export type FallbackSummaryOptions = {
	/** Estimated token budget for the whole summary; it is never exceeded. */
	maxTokens: number;
	/** Observation pool threshold forwarded to the projection, matching the compaction `details`. Unbounded when omitted. */
	observationsPoolMaxTokens?: number;
};

/**
 * Deterministic summary built without a model, for compactions that cannot
 * keep the unobserved source in context. Ledger records come first (newest
 * first within budget, each truncated if oversized), then a notice counting the
 * source entries before `foldThroughEntryId` that no memory record describes,
 * with a short excerpt of each human-authored one. An empty ledger yields
 * {@link NO_MEMORY_NOTICE} in place of the records.
 */
export function renderFallbackSummary(entries: Entry[], foldThroughEntryId: string, opts: FallbackSummaryOptions): string {
	const projection = buildCompactionProjection(entries, foldThroughEntryId, {
		observationsPoolMaxTokens: opts.observationsPoolMaxTokens ?? Number.POSITIVE_INFINITY,
	});
	const foldIndex = entryIndexForId(entries, foldThroughEntryId);
	const gap = foldIndex === -1 ? undefined : unobservedSourceSpanBefore(entries, foldIndex);
	const hasLedger = projection.reflections.length + projection.observations.length > 0;

	let budget = opts.maxTokens - blockTokens(FALLBACK_HEADER);
	if (!hasLedger) budget -= blockTokens(NO_MEMORY_NOTICE);

	let unobserved: string[] = [];
	if (gap) {
		const notice = `${describeUnobservedSpan(gap)} before this point were never observed, so no memory record describes them and they are no longer in context.`;
		budget -= blockTokens(notice);
		const candidates: string[] = [];
		let newestIndex = -1;
		for (let i = gap.firstIndex; i <= gap.lastIndex; i++) {
			if (!isSourceEntry(entries[i])) continue;
			if (entryExcerptSource(entries[i])) newestIndex = i;
		}
		for (let i = gap.firstIndex; i <= gap.lastIndex; i++) {
			if (!isSourceEntry(entries[i])) continue;
			const text = excerptOf(entryExcerptSource(entries[i]) ?? "", i === newestIndex ? LATEST_EXCERPT_MAX_CHARS : EXCERPT_MAX_CHARS);
			if (text) candidates.push(`- ${text}`);
		}
		const excerptBudget = Math.floor(Math.max(0, budget) * FALLBACK_EXCERPT_SHARE);
		let excerpts = pickNewestExcerpts(candidates, excerptBudget);
		if (excerpts.length < candidates.length) excerpts = pickNewestExcerpts(candidates, excerptBudget - OMITTED_EXCERPTS_NOTE_TOKENS);
		const lines = [notice];
		if (excerpts.length > 0) lines.push(`Excerpts of the unobserved input:\n${excerpts.join("\n")}`);
		if (excerpts.length < candidates.length) {
			const omitted = candidates.length - excerpts.length;
			lines.push(`(${omitted} more unobserved input${omitted === 1 ? "" : "s"} not shown.)`);
		}
		unobserved = lines;
		budget -= blockTokens(lines.slice(1).join("\n"));
	}

	const parts: string[] = [FALLBACK_HEADER];
	if (hasLedger) {
		const sectionBudget = Math.max(0, budget - blockTokens("## Reflections") - blockTokens("## Observations"));
		const reserved = selectTruncatedLines(projection.observations, observationToSummaryLine, Math.floor(sectionBudget * SUMMARY_OBSERVATIONS_MIN_SHARE));
		const reflectionLines = selectTruncatedLines(projection.reflections, reflectionToSummaryLine, sectionBudget - reserved.tokens);
		const observationLines = selectTruncatedLines(projection.observations, observationToSummaryLine, sectionBudget - reflectionLines.tokens);
		if (reflectionLines.lines.length > 0) parts.push(`## Reflections\n${reflectionLines.lines.join("\n")}`);
		if (observationLines.lines.length > 0) parts.push(`## Observations\n${observationLines.lines.join("\n")}`);
	} else {
		parts.push(NO_MEMORY_NOTICE);
	}
	parts.push(...unobserved);

	return truncateToTokens(parts.join("\n\n"), opts.maxTokens);
}

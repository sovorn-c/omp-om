import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

export interface Config {
	observeAfterTokens: number;
	reflectAfterTokens: number;
	/**
	 * Maximum estimated source tokens serialized into a single observer chunk.
	 * Unset (default) derives the cap from the resolved memory model's context
	 * window; see {@link resolveObserverChunkMaxTokens}.
	 */
	observerChunkMaxTokens?: number;
	/**
	 * Memory model for observer, reflector, and dropper: any spec accepted by
	 * omp's `ctx.models.resolve` (`provider/id`, a bare id, or a role alias such
	 * as `@smol`). The one model for every worker; there are no per-worker
	 * overrides.
	 */
	model: string;
	/**
	 * Maximum estimated source tokens the compaction hook may keep in context
	 * when it moves Pi's retention boundary back to the observer frontier so
	 * that unobserved entries are not discarded. Unset (default) derives the
	 * budget from the active session model's context window; see
	 * {@link resolveCompactionMaxRetainedTokens}.
	 */
	compactionMaxRetainedTokens?: number;
	/**
	 * Estimated token budget for the memory summary the compaction hook renders.
	 * Unset (default) derives it from the session model's context window; see
	 * {@link resolveCompactionSummaryMaxTokens}.
	 */
	compactionSummaryMaxTokens?: number;
	/**
	 * Maximum observer chunks the compaction hook may run synchronously to cover
	 * source entries the background observer has not reached before Pi's cut,
	 * so the hook can own the compaction instead of delegating to Pi's native
	 * summarizer. 0 disables synchronous catch-up.
	 */
	compactionCatchUpMaxChunks: number;
	/**
	 * Estimated token budget for the prior memory (reflections and observations)
	 * carried by each observer, reflector, and dropper request. Unset derives it
	 * from the memory model's context window; see {@link resolveWorkerMemoryMaxTokens}.
	 */
	workerMemoryMaxTokens?: number;
	observationsPoolMaxTokens: number;
	observationsPoolTargetTokens: number;
	agentMaxTurns: number;
	/**
	 * Maximum output tokens requested for background memory-agent loops
	 * (observer/reflector/dropper). Always clamped to the model's own
	 * `maxTokens` when available. Lower it for local servers with a modest
	 * context window, where concurrent sub-agent requests share KV with the
	 * main session and the default 32K response budget can overflow the slot.
	 */
	agentMaxTokens: number;
	showWorkerNotifications: boolean;
	passive: boolean;
	debugLog: boolean;
}

export const DEFAULTS: Config = {
	observeAfterTokens: 10_000,
	reflectAfterTokens: 20_000,
	observationsPoolMaxTokens: 20_000,
	observationsPoolTargetTokens: 10_000,
	agentMaxTurns: 16,
	agentMaxTokens: 32_000,
	compactionCatchUpMaxChunks: 2,
	model: "@smol",
	showWorkerNotifications: true,
	passive: false,
	debugLog: false,
};

/** Thinking level for every memory worker call; the one `model` key carries no per-model setting. */
export const WORKER_THINKING_LEVEL = "low";

/** Retained-tail budget used when `compactionMaxRetainedTokens` is unset and the context window is unknown. */
export const COMPACTION_RETAINED_FALLBACK_MAX_TOKENS = 60_000;

/**
 * Fraction of the session model's context window the compaction hook may keep
 * when it retains unobserved source entries past Pi's proposed cut. Half the
 * window leaves room for the rendered memory summary, system prompt, tool
 * schemas, and the next response even when the ~4 chars/token estimate
 * undercounts real tokens.
 */
export const COMPACTION_RETAINED_CONTEXT_RATIO = 0.5;

/**
 * Resolve how many estimated source tokens the compaction hook may retain when
 * observation coverage lags behind Pi's proposed retention boundary.
 *
 * An explicit `compactionMaxRetainedTokens` always wins. Otherwise the budget
 * is `floor(contextWindow * COMPACTION_RETAINED_CONTEXT_RATIO)` for the active
 * session model, falling back to {@link COMPACTION_RETAINED_FALLBACK_MAX_TOKENS}
 * when the window is unknown.
 */
export function resolveCompactionMaxRetainedTokens(config: Config, contextWindow: number | undefined): number {
	if (config.compactionMaxRetainedTokens !== undefined && config.compactionMaxRetainedTokens > 0) {
		return config.compactionMaxRetainedTokens;
	}
	if (typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0) {
		return Math.max(1, Math.floor(contextWindow * COMPACTION_RETAINED_CONTEXT_RATIO));
	}
	return COMPACTION_RETAINED_FALLBACK_MAX_TOKENS;
}

/** Summary budget used when `compactionSummaryMaxTokens` is unset and the context window is unknown. */
export const COMPACTION_SUMMARY_FALLBACK_MAX_TOKENS = 8_000;

/** Fraction of the session model's context window the rendered memory summary may occupy by default. */
export const COMPACTION_SUMMARY_CONTEXT_RATIO = 0.125;

/**
 * Resolve the estimated token budget for the rendered compaction summary. An
 * explicit `compactionSummaryMaxTokens` wins; otherwise one eighth of the
 * session model's context window, or {@link COMPACTION_SUMMARY_FALLBACK_MAX_TOKENS}
 * when the window is unknown.
 */
export function resolveCompactionSummaryMaxTokens(config: Config, contextWindow: number | undefined): number {
	if (config.compactionSummaryMaxTokens !== undefined && config.compactionSummaryMaxTokens > 0) {
		return config.compactionSummaryMaxTokens;
	}
	if (typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0) {
		return Math.max(1, Math.floor(contextWindow * COMPACTION_SUMMARY_CONTEXT_RATIO));
	}
	return COMPACTION_SUMMARY_FALLBACK_MAX_TOKENS;
}

/** Worker prior-memory budget used when unset and the memory model's context window is unknown. */
export const WORKER_MEMORY_FALLBACK_MAX_TOKENS = 16_000;

/** Fraction of the memory model's context window worker prompts may spend on prior memory. */
export const WORKER_MEMORY_CONTEXT_RATIO = 0.25;

/**
 * Resolve the prior-memory budget for worker prompts. Explicit
 * `workerMemoryMaxTokens` wins; otherwise a quarter of the memory model's
 * context window, or {@link WORKER_MEMORY_FALLBACK_MAX_TOKENS} when unknown.
 * Together with the observer chunk cap (a fifth of the window) and the output
 * reservation this keeps a worker request inside the window.
 */
export function resolveWorkerMemoryMaxTokens(config: Config, contextWindow: number | undefined): number {
	if (config.workerMemoryMaxTokens !== undefined && config.workerMemoryMaxTokens > 0) return config.workerMemoryMaxTokens;
	if (typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0) {
		return Math.max(1, Math.floor(contextWindow * WORKER_MEMORY_CONTEXT_RATIO));
	}
	return WORKER_MEMORY_FALLBACK_MAX_TOKENS;
}

/** Observer chunk cap used when no config is set and the model's context window is unknown. */
export const OBSERVER_CHUNK_FALLBACK_MAX_TOKENS = 60_000;

/** Smallest useful observer chunk: enough for labels, omission markers, and source context. */
export const OBSERVER_CHUNK_MIN_TOKENS = 256;

/**
 * Fraction of the memory model's context window used for the derived observer
 * chunk cap. Chunk sizes are estimated at ~4 chars/token, which can undercount
 * real tokens by up to ~4x on non-ASCII content, so 0.2 keeps even the worst
 * case at ~80% of the window with room left for the system prompt, prior
 * memory, and the response.
 */
export const OBSERVER_CHUNK_CONTEXT_RATIO = 0.2;

/**
 * Resolve the maximum estimated tokens the observer serializes into one chunk.
 *
 * An explicit `observerChunkMaxTokens` config value always wins. Otherwise the
 * cap is `floor(contextWindow * OBSERVER_CHUNK_CONTEXT_RATIO)` for the resolved
 * memory model, falling back to {@link OBSERVER_CHUNK_FALLBACK_MAX_TOKENS} when
 * the context window is unavailable.
 *
 * Without a cap, a backlog that outgrows the model's context window (e.g.
 * after repeated observer failures, or when the extension is enabled mid-way
 * into a long session) makes every observer call fail, so coverage never
 * advances and the session can never recover. With the cap, oversized backlogs
 * are drained oldest-first across successive runs.
 */
export function resolveObserverChunkMaxTokens(config: Config, contextWindow: number | undefined): number {
	if (config.observerChunkMaxTokens !== undefined && config.observerChunkMaxTokens > 0) {
		return Math.max(OBSERVER_CHUNK_MIN_TOKENS, config.observerChunkMaxTokens);
	}
	if (typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0) {
		return Math.max(
			OBSERVER_CHUNK_MIN_TOKENS,
			Math.floor(contextWindow * OBSERVER_CHUNK_CONTEXT_RATIO),
		);
	}
	return OBSERVER_CHUNK_FALLBACK_MAX_TOKENS;
}

const CONFIG_FILE = "omp-om.yml";
const LEGACY_CONFIG_FILE = "omp-om.json";

/**
 * Written to `<agentDir>/omp-om.yml` on first run so every option is visible
 * and editable. It restates {@link DEFAULTS}; a test keeps the two in step.
 * Keys whose default is derived at runtime stay commented out.
 */
export const DEFAULT_CONFIG_YAML = `# omp-om settings. Every key is optional; delete a line to get its default.
# A project file at <project>/.omp/omp-om.yml is merged over this one.

# Memory model for observer, reflector and dropper: provider/id, a bare id,
# or a role alias such as @smol.
model: "@smol"

# Run the observer when this many tokens of conversation are unobserved.
observeAfterTokens: 10000
# Run the reflector when this many tokens of observations are unreflected.
reflectAfterTokens: 20000
# Keep observeAfterTokens < reflectAfterTokens < omp's compaction threshold.

# Active observation budget; reaching it makes compaction a full fold.
observationsPoolMaxTokens: 20000
# Size the dropper trims toward (default: half of observationsPoolMaxTokens).
# observationsPoolTargetTokens: 10000

# Turn cap and output token request for each worker loop.
agentMaxTurns: 16
agentMaxTokens: 32000

# Observer chunks allowed synchronously before a compaction; 0 disables.
compactionCatchUpMaxChunks: 2

# Derived from the model's context window when unset:
# observerChunkMaxTokens: 60000
# workerMemoryMaxTokens: 16000
# compactionSummaryMaxTokens: 8000
# compactionMaxRetainedTokens: 60000

showWorkerNotifications: true
# Turn off the automatic workers; commands and the compaction hook stay active.
passive: false
debugLog: false
`;
const PASSIVE_ENV = "PI_OBSERVATIONAL_MEMORY_PASSIVE";

/** Keys earlier versions accepted that no longer do. They are ignored with a warning. */
const REMOVED_KEYS = [
	"compactAfterTokens",
	"compactAfterTokensMode",
	"compactAfterTokensRatio",
	"consolidateWhenIdle",
	"fallbackModel",
] as const;

function positiveIntegerOrUndefined(value: unknown): number | undefined {
	return Number.isInteger(value) && typeof value === "number" && value > 0 ? value : undefined;
}

function validTargetOrUndefined(value: unknown, maxTokens: number): number | undefined {
	const target = positiveIntegerOrUndefined(value);
	return target !== undefined && target < maxTokens ? target : undefined;
}

function derivedObservationPoolTarget(maxTokens: number): number {
	return Math.floor(maxTokens / 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeSettingsConfig(path: string, value: Record<string, unknown>, warnings: string[]): Partial<Config> {
	const normalized: Partial<Config> = {};
	const numberKeys = [
		"observeAfterTokens",
		"reflectAfterTokens",
		"observerChunkMaxTokens",
		"compactionMaxRetainedTokens",
		"compactionSummaryMaxTokens",
		"workerMemoryMaxTokens",
		"observationsPoolMaxTokens",
		"observationsPoolTargetTokens",
		"agentMaxTurns",
		"agentMaxTokens",
	] as const;
	for (const key of numberKeys) {
		const normalizedValue = positiveIntegerOrUndefined(value[key]);
		if (normalizedValue !== undefined) normalized[key] = normalizedValue;
	}
	if (Number.isInteger(value.compactionCatchUpMaxChunks) && (value.compactionCatchUpMaxChunks as number) >= 0) {
		normalized.compactionCatchUpMaxChunks = value.compactionCatchUpMaxChunks as number;
	}
	if (typeof value.showWorkerNotifications === "boolean") normalized.showWorkerNotifications = value.showWorkerNotifications;
	if (typeof value.passive === "boolean") normalized.passive = value.passive;
	if (typeof value.debugLog === "boolean") normalized.debugLog = value.debugLog;
	if (value.model !== undefined) {
		const model = nonEmptyString(value.model);
		if (model) normalized.model = model;
		else warnings.push(`${path}: "model" must be a non-empty string such as "@smol" or "provider/id"; ignored`);
	}
	for (const key of REMOVED_KEYS) {
		if (key in value) warnings.push(`${path}: "${key}" is no longer supported; ignored`);
	}
	return normalized;
}

export function readEnvConfig(env: NodeJS.ProcessEnv = process.env): Partial<Config> {
	const rawPassive = env[PASSIVE_ENV];
	if (rawPassive === undefined) return {};
	const passive = rawPassive.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(passive)) return { passive: true };
	if (["0", "false", "no", "off"].includes(passive)) return { passive: false };
	return {};
}

function readConfigFile(path: string, warnings: string[]): Partial<Config> {
	if (!existsSync(path)) return {};
	let raw: unknown;
	try {
		raw = parseYaml(readFileSync(path, "utf-8"));
	} catch (error) {
		warnings.push(`${path}: ${error instanceof Error ? error.message : String(error)}; using defaults for this file`);
		return {};
	}
	if (raw === null || raw === undefined) return {};
	if (!isRecord(raw) || Array.isArray(raw)) {
		warnings.push(`${path}: expected a YAML mapping of keys to values; using defaults for this file`);
		return {};
	}
	return normalizeSettingsConfig(path, raw, warnings);
}

function warnLegacyConfig(dir: string, warnings: string[]): void {
	const legacy = join(dir, LEGACY_CONFIG_FILE);
	if (existsSync(legacy)) {
		warnings.push(`${legacy}: omp-om now reads ${CONFIG_FILE}; move these settings there and delete this file`);
	}
}

/**
 * Create `<agentDir>/omp-om.yml` with the documented defaults when the user has
 * no settings file yet. Never overwrites, and stays out of the way of a
 * leftover `omp-om.json` (which `loadConfig` warns about). Returns warnings.
 */
export function ensureGlobalConfig(agentDir: string): string[] {
	const path = join(agentDir, CONFIG_FILE);
	if (existsSync(path) || existsSync(join(agentDir, LEGACY_CONFIG_FILE))) return [];
	try {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(path, DEFAULT_CONFIG_YAML, { encoding: "utf-8", flag: "wx" });
		return [];
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return [];
		return [`${path}: could not create default settings file: ${error instanceof Error ? error.message : String(error)}`];
	}
}

/**
 * Load `<agentDir>/omp-om.yml`, then merge `<cwd>/.omp/omp-om.yml` and the
 * passive env override over it. Problems never throw: a bad file contributes
 * nothing and adds one warning for the caller to surface.
 */
export function loadConfig(
	cwd: string,
	agentDir: string,
	env: NodeJS.ProcessEnv = process.env,
): { config: Config; warnings: string[] } {
	const warnings: string[] = [];
	warnLegacyConfig(agentDir, warnings);
	warnLegacyConfig(join(cwd, ".omp"), warnings);
	const globalConfig = readConfigFile(join(agentDir, CONFIG_FILE), warnings);
	const projectConfig = readConfigFile(join(cwd, ".omp", CONFIG_FILE), warnings);
	const envConfig = readEnvConfig(env);
	const merged = {
		...DEFAULTS,
		observationsPoolTargetTokens: undefined,
		...globalConfig,
		...projectConfig,
		...envConfig,
	};
	const target = validTargetOrUndefined(
		merged.observationsPoolTargetTokens,
		merged.observationsPoolMaxTokens,
	) ?? derivedObservationPoolTarget(merged.observationsPoolMaxTokens);

	return { config: { ...merged, observationsPoolTargetTokens: target }, warnings };
}

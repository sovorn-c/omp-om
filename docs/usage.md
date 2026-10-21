# omp-om usage

See the [README](../README.md) for what omp-om is and how to install it. Everything below is read from `src/` or observed in the smoke runs in [smoke-results.md](smoke-results.md); statements that were only read from code say so.

## Configuration

Files, merged in this order (later wins): built-in defaults, `<agent dir>/omp-om.json` (normally `~/.omp/agent/omp-om.json`), `<cwd>/.omp/omp-om.json`, then the `PI_OBSERVATIONAL_MEMORY_PASSIVE` environment variable for `passive` only.

A bad file never throws. A file that is not valid JSON, or not a JSON object, is skipped and contributes one warning. A single bad value is ignored and the default stays. Keys must be positive integers where numbers are expected (`compactionCatchUpMaxChunks` may be `0`).

| Key | Default | Meaning |
| --- | --- | --- |
| `model` | `"@smol"` | The one memory model for observer, reflector and dropper. Any spec omp's `ctx.models.resolve` accepts: `provider/id`, a bare id, or a role alias like `@smol`. Must be a non-empty string. Only available (authenticated) models resolve. |
| `observeAfterTokens` | `10000` | Observation runs when uncovered source reaches this many tokens. Progress is the larger of the raw uncovered estimate and the provider-reported context growth since the last record. Until the first record (or a compaction) exists there is no growth baseline, so only the raw source estimate counts; omp's system prompt and tool schemas do not make a new session due. |
| `reflectAfterTokens` | `20000` | Same, for reflection runs, counted over observed tokens. |
| `observationsPoolMaxTokens` | `20000` | Active observation budget. When the observations folded at compaction reach it, the compaction is a *full fold* (see below). |
| `observationsPoolTargetTokens` | half of max | Target the dropper trims toward. Ignored if not smaller than max. |
| `agentMaxTurns` | `16` | Turn cap for each worker loop. omp has no per-turn hook, so omp-om counts completed assistant turns and aborts the loop at the cap; records made before the abort are kept and the abort is not reported as an error. |
| `agentMaxTokens` | `32000` | Output token request for worker loops, clamped to the model's own `maxTokens`. Lower it for local servers with a small context. |
| `compactionCatchUpMaxChunks` | `2` | Observer chunks the hook may run synchronously before a compaction. `0` disables catch-up. |
| `observerChunkMaxTokens` | derived | Cap on one observer chunk (minimum `256`). Unset: a fifth of the memory model's context window, or `60000` if unknown. |
| `workerMemoryMaxTokens` | derived | Budget for prior memory carried by each worker request. Unset: a quarter of the memory model's window, or `16000`. |
| `compactionSummaryMaxTokens` | derived | Budget for the rendered summary. Unset: an eighth of the session model's window, or `8000`. |
| `compactionMaxRetainedTokens` | derived | How much unobserved source the hook may keep in context past omp's cut. Unset: half of the session model's window, or `60000`. |
| `showWorkerNotifications` | `true` | Show worker progress notices when the session has a UI. |
| `passive` | `false` | Disable the automatic workers. Commands, `om_recall` and the compaction hook stay active. |
| `debugLog` | `false` | Write per-session debug events as NDJSON under `<agent dir>/observational-memory/debug/<session id>.ndjson` (or `observational-memory/debug.ndjson` without a session id). |

Worker thinking level is fixed at `low`. The 20 second hook deadline is a constant in code (`HOOK_CATCH_UP_DEADLINE_MS`), not a config key.

Keys removed from Pi OM, ignored with a warning: `compactAfterTokens`, `compactAfterTokensMode`, `compactAfterTokensRatio`, `consolidateWhenIdle`, `fallbackModel`. omp's own threshold (for example `compaction.thresholdTokens`) decides when compaction fires. omp-om has no `agent_settled` trigger.

Keep `observeAfterTokens` < `reflectAfterTokens` < omp's compaction threshold, so the ledger is ahead of the cut when omp compacts.

Subagent sessions (omp rebinds extensions into every task subagent; `ctx.agent.kind === "sub"`) never run the background workers. The main session's ledger is the only one that is observed, reflected and dropped. The compaction hook still runs if a subagent session compacts. This follows omp's extension types and the unit tests; it was not exercised live.

## What the compaction summary contains

The summary is the ledger render: usage instructions, then `## Reflections` (when present), then `## Observations`, within `compactionSummaryMaxTokens`. Reflections enter the summary only after a *full fold*, which happens when the folded observations reach `observationsPoolMaxTokens`. In the smoke run a reflection was recorded but the first compaction rendered observations only (`details.fullFold` was `false`); this follows `buildCompactionProjection` in `src/session-ledger/projection.ts`. The compaction entry carries `details` with the folded observations and reflections.

## Fallback ladder at compaction

The hook (`src/hooks/compaction-hook.ts`) never throws and never returns `undefined`:

1. **Catch up.** If the observer has not reached omp's cut, observe the gap, up to `compactionCatchUpMaxChunks` chunks, with or without a prior coverage marker, under a 20 second deadline. Chunks recorded before a deadline or error are kept.
2. **Render the ledger so far.** If catch-up could not finish (deadline, model unavailable, error, abort), do no further observing or reflecting, and render the recorded ledger. If the unobserved tail still fits the retained budget, the cut moves back so the tail stays in context; omp-om shows an info notice.
3. **Model-free summary.** If the tail cannot be retained, or no record fits the summary budget, the hook renders a deterministic summary with no model: a fixed header, the ledger that fits, and excerpts of the unobserved input. With an empty ledger it says no memory was recorded.
4. **Last resort.** If the hook body itself throws, it keeps omp's cut and renders whatever still works, or a fixed notice. A signal abort cancels the compaction instead. A second compaction while one is running is cancelled as a duplicate.

## `/clear` and `reset_boundary`

`/clear` appends a `reset_boundary` entry. omp-om treats the latest one as a floor: entries at or before it are ignored for catch-up, coverage and the rendered summary, so memory from before `/clear` does not leak into a fresh context. A worker run that was already in flight when you cleared may still append its record after the boundary; records whose coverage marker points at or before the boundary are ignored too. This is implemented in `src/session-ledger/progress.ts`, `fold.ts` and `projection.ts` and covered by unit tests; it was not exercised in the smoke runs.

## Commands and tool

- `/om:status`: memory counts, progress toward the next observation and reflection, observer backlog since the last compaction, a passive-mode line when `passive` is on, config warnings, and the last observer, reflector and dropper errors.
- `/om:view`: print and copy the visible memory. `/om:view full` includes recorded memory that the summary omits. Any other argument prints the usage line.
- `om_recall`: takes a 12-character lowercase hex id. An id that is not on the current branch returns "No observation or reflection with id … was found on the current branch."

## Troubleshooting

Warnings appear only when the session has a UI (`ctx.hasUI`). In the smoke runs the session was driven over `--mode rpc` with UI enabled and the warnings arrived as `notify` events. In sessions without a UI they are not shown; turn on `debugLog` to see the underlying events.

| Message | Cause and fix |
| --- | --- |
| `observer skipped — memory model "…" did not resolve to an available model; set "model" in omp-om.json` | `model` is unset, misspelled, or has no credentials. Shown once per session. Workers skip; compaction still works. Fix `model`. |
| `memory model unavailable: …; compacting without catching up the observer` | Same cause, hit during a compaction. The ledger recorded so far is rendered. |
| `observer catch-up reached the 20s hook deadline; compacting with the memory recorded so far` | The model was too slow to reach the cut. Use a faster `model`, or lower `observeAfterTokens` so the background observer stays ahead. |
| `observer catch-up failed: …; compacting with the memory recorded so far` | The observer call failed during catch-up. The reason text comes from the provider. |
| `observer has not reached N source entries (~T tokens) before the compaction cut and they cannot be retained (…); compacting with a model-free summary of the memory so far` | Step 3 of the ladder. The reason in parentheses says why (`no observation coverage`, retained budget exceeded, nothing observed can be compacted). |
| `observer has not reached … before the compaction cut; keeping them in context until they are observed` | Info only. Step 2: the cut moved back to keep the tail. |
| `no memory record fits the ~N-token summary budget; using a truncated model-free summary` | `compactionSummaryMaxTokens` is too small for the smallest record. Raise it. |
| `compaction hook failed (…); compacting with a model-free summary` | Unexpected error in the hook. Enable `debugLog` and report it. |
| `another compaction is already in progress; cancelling duplicate` | A second `session_before_compact` arrived while one was running. |
| `<phase> failed: …` | A background worker (observer, reflector, dropper) failed. The ledger simply does not advance. |

Other checks:

- **Config warnings.** A bad `omp-om.json` (malformed file, removed key, invalid `model`) is reported by `/om:status` under "Config warnings", naming the file. Check the JSON and the key names against the table above.
- **No `om.*` entries appear.** Check `/om:status` for a last worker error, look for the `observer skipped` warning (memory model did not resolve), and check that `passive` is not on.
- **Zero model calls wanted.** Not possible with omp-om; see the honest limit in the README.
- **Mnemopi cost.** If Mnemopi's `llmMode` is `smol` and omp-om's `model` is `@smol`, both call the same model and share its cost and rate limits.

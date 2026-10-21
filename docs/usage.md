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

The hook (`src/hooks/compaction-hook.ts`) checks memory health before supplying a ledger summary:

1. **Delegate during an outage.** Resolution/authentication failures, worker request failures, catch-up errors, unexpected hook errors and the 20 second deadline warn and return `undefined`, allowing omp's normal compaction. The deadline includes authentication lookup, even with complete coverage or catch-up disabled. Late catch-up results cannot append after the deadline.
2. **Catch up while healthy.** If the observer has not reached omp's cut, observe the gap up to `compactionCatchUpMaxChunks` chunks. Completed chunks remain in the journal. An intentional empty result or chunk cap is healthy; if the remaining tail fits the budget, move the cut back to retain it and render the ledger.
3. **Handle healthy budget limits.** If the tail cannot be retained, or no record fits the summary budget, render a deterministic summary: a fixed header, the ledger that fits and excerpts of unobserved input. With an empty ledger it says no memory was recorded. This budget fallback applies while memory work is healthy.
4. **Preserve cancellation.** A user abort cancels compaction. A second compaction while one is running is cancelled as a duplicate.

Memory failures stop the current worker pass, including its later stages. Routine scheduled passes may try again; launching a pass or resolving the model does not clear the outage. A successful observer, reflector or dropper request clears it, including a successful request that produces no records. Existing journal records remain available. Error warnings are shown even when `showWorkerNotifications` is `false`; that option controls routine progress only.

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
| `observer failed: memory model "…" did not resolve …` | Fix `model` or credentials. This memory pass stops; omp uses normal compaction until a worker request succeeds. Repeated identical background failures are deduplicated while the same outage remains active. |
| `memory model unavailable: …; … using omp's normal compaction` | Resolution or authentication failed during preflight. omp receives no compaction override. |
| `memory work reached the 20s hook deadline` | Authentication or catch-up took too long. omp receives normal compaction; late worker results are ignored. |
| `observer catch-up failed: …` | The catch-up request failed. The provider reason is included; omp performs normal compaction. |
| `observer has not reached N source entries …; compacting with a model-free summary …` | Healthy budget fallback: the unobserved tail cannot be retained. |
| `observer has not reached …; keeping them in context until they are observed` | Info only: the cut moved back to retain the tail. |
| `no memory record fits the ~N-token summary budget; using a truncated model-free summary` | Raise `compactionSummaryMaxTokens`. |
| `compaction hook failed: …` | Unexpected hook error. omp receives normal compaction. Enable `debugLog` and report it. |
| `another compaction is already in progress; cancelling duplicate` | A second `session_before_compact` arrived while one was running. |
| `<phase> failed: …; … Memory updates stopped for this pass …` | A background observer, reflector or dropper failed. Conversation can continue; compaction delegates to omp until a worker succeeds. |

Other checks:

- **Config warnings.** A bad `omp-om.json` (malformed file, removed key, invalid `model`) is reported by `/om:status` under "Config warnings", naming the file. Check the JSON and the key names against the table above.
- **No `om.*` entries appear.** Check `/om:status` for a last worker error, look for a memory failure warning, and check that `passive` is not on.
- **Zero model calls wanted.** Not possible with omp-om; see the honest limit in the README.
- **Mnemopi cost.** If Mnemopi's `llmMode` is `smol` and omp-om's `model` is `@smol`, both call the same model and share its cost and rate limits.

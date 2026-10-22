# omp-om

Observational memory for omp. It keeps a structured ledger of what happened in a session and uses that ledger as the compaction summary, so long sessions keep their decisions and context without a full re-summarization.

## How it works

While you work, three background workers write observations to the session journal:

- **Observer**: distills new conversation into timestamped observations.
- **Reflector**: distills durable reflections from observations.
- **Dropper**: drops observations that reflections already cover, to keep the pool small.

When omp compacts, omp-om renders the ledger as the compaction summary and omp skips its own summarizer. If the ledger is behind, omp-om catches the observer up first, within a 20 second deadline.

If the memory model can't be resolved, authenticated or reached, omp-om warns, stops that memory pass and hands compaction back to omp's normal summarizer. Your conversation keeps working. The next successful worker request restores ledger compaction.

### Model usage

Ledger compaction avoids omp's summarization call, but the workers (and any observer catch-up before a compaction) still call your memory model. If you want zero model calls, use omp's native `snapcompact` + `shake` instead.

## Install

Requires omp and Node.js 22.19 or newer. The repository ships a prebuilt `dist/`, so no build step is needed.

**Install from GitHub (recommended):**

```bash
omp plugin install github:sovorn-c/omp-om
```

**Or from a local clone:**

```bash
git clone https://github.com/sovorn-c/omp-om.git
omp plugin link ./omp-om
```

Check it with `omp plugin list`, then start omp as usual.

**Try it for one run without installing:**

```bash
omp -e /path/to/omp-om
```

To remove it: `omp plugin uninstall omp-om`.

## Update

- Installed from GitHub: `omp plugin upgrade omp-om`, then restart omp.
- Linked from a clone: `git pull` in the clone, then restart omp. `dist/` is committed, so no rebuild is needed.

Your `omp-om.yml` and existing session memory are untouched by updates.

## Quick start

1. Install the plugin (above) and start omp. It works with no configuration: the memory model defaults to your `@smol` role model.
2. Work normally. omp-om observes the session in the background once enough conversation has built up (about 10,000 tokens by default).
3. Run `/om:status` to see memory counts and progress toward the next observation.
4. Run `/om:view` to see what has been remembered. When omp compacts, this ledger becomes the summary.
5. To use a different or cheaper memory model, or tune thresholds, edit `~/.omp/agent/omp-om.yml`. omp-om creates it with every default on first start (see [Configuration](#configuration)).

omp-om never edits omp's settings. omp's compaction stays on and omp's own threshold decides when it fires. Keep `observeAfterTokens` < `reflectAfterTokens` < omp's compaction threshold so the ledger is ahead of the cut.

## Compaction methods

Leave `compaction.methodOrder` (`remote`, `handoff`, `snapcompact`, `soft`, `shake`) as it is; nothing needs turning off.

- **Memory healthy:** omp-om supplies the summary, so omp's summary methods are not used. Handoff and snapcompact generation are skipped, and omp's background (speculative) compaction is disabled while omp-om is loaded because omp does not speculate when an extension intercepts compaction. omp still decides the trigger and the cut.
- **Memory model missing or failing:** omp-om warns once, stops observing and reflecting, and returns control to omp. omp then runs the first usable method in your `methodOrder`, exactly as it would without omp-om.
- **Display only:** omp may label the compaction with the method it selected (for example `handoff`) even though omp-om wrote the summary. Check `/om:view` or the compaction entry's `fromExtension`.

## Configuration

omp-om reads one YAML file, `omp-om.yml`:

- **Global:** `~/.omp/agent/omp-om.yml` (`<agent dir>/omp-om.yml`). Created with all defaults and comments the first time omp-om starts, if it does not exist. Never overwritten.
- **Project override:** `<project>/.omp/omp-om.yml`, merged over the global file. Not created automatically.
- **Environment:** `OMP_OM_PASSIVE` (`1`/`true`/`yes`/`on` or `0`/`false`/`no`/`off`) overrides only `passive`.

Every key is optional; delete a line to get its default. The generated file looks like this (keys with derived defaults are commented out):

```yaml
model: "@smol"
observeAfterTokens: 10000
reflectAfterTokens: 20000
observationsPoolMaxTokens: 20000
# observationsPoolTargetTokens: 10000
agentMaxTurns: 16
agentMaxTokens: 32000
compactionCatchUpMaxChunks: 2
showWorkerNotifications: true
passive: false
debugLog: false
```

The smallest useful file just picks a model:

```yaml
model: "@smol"
```

A bad file never breaks omp. A file that is not valid YAML or not a mapping is skipped with a warning, and a single bad value is ignored so the default stays. Numeric values must be positive integers (`compactionCatchUpMaxChunks` may be `0`). `/om:status` lists config warnings.

Earlier builds read `omp-om.json`. That file is no longer read: if one exists, omp-om does not create `omp-om.yml` and `/om:status` warns until you move the settings over and delete it.

### Options

| Key | Default | Meaning |
| --- | --- | --- |
| `model` | `"@smol"` | The one memory model for observer, reflector and dropper. Accepts anything omp can resolve: `provider/id`, a bare model id, or a role alias such as `@smol`. The model must be available (authenticated). |
| `observeAfterTokens` | `10000` | Run the observer when this many tokens of conversation are not yet observed. |
| `reflectAfterTokens` | `20000` | Run the reflector when this many tokens of observations are not yet reflected on. |
| `observationsPoolMaxTokens` | `20000` | Active observation budget. When folded observations reach it, compaction does a full fold that also includes reflections. |
| `observationsPoolTargetTokens` | half of `observationsPoolMaxTokens` | Size the dropper trims the pool toward. Ignored if not smaller than the max. Not in the block above because it follows the max. |
| `agentMaxTurns` | `16` | Turn cap for each worker loop. Records written before the cap is hit are kept. |
| `agentMaxTokens` | `32000` | Output token request for worker loops, clamped to the model's own limit. Lower it for local servers with a small context. |
| `compactionCatchUpMaxChunks` | `2` | Observer chunks allowed synchronously before a compaction. `0` disables catch-up. |
| `observerChunkMaxTokens` | derived | Cap on one observer chunk (minimum `256`). Unset: a fifth of the memory model's context window, or `60000` if unknown. |
| `workerMemoryMaxTokens` | derived | Budget for prior memory carried by each worker request. Unset: a quarter of the memory model's window, or `16000`. |
| `compactionSummaryMaxTokens` | derived | Budget for the rendered summary. Unset: an eighth of the session model's window, or `8000`. |
| `compactionMaxRetainedTokens` | derived | How much unobserved conversation may stay in context past omp's cut. Default `30000`; if unset, one eighth of the session model's window. |
| `showWorkerNotifications` | `true` | Show routine worker progress notices when the session has a UI. Failure warnings are always shown. |
| `passive` | `false` | Turn off the automatic workers. The commands, `om_recall` and the compaction hook stay active. |
| `debugLog` | `false` | Write debug events as NDJSON under `<agent dir>/observational-memory/debug/<session id>.ndjson`. |

Worker thinking level is fixed at `low`. Options inherited from Pi OM that omp-om no longer supports (`compactAfterTokens`, `compactAfterTokensMode`, `compactAfterTokensRatio`, `consolidateWhenIdle`, `fallbackModel`) are ignored with a warning.

Subagent sessions never run the background workers; only the main session's ledger is observed.

## Tool and commands

- **`om_recall`** tool: recovers the source evidence behind an observation or reflection id (12-character lowercase hex, shown in the summary or in `/om:view`). Named `om_recall` because Mnemopi already registers `recall` in omp.
- **`/om:status`**: memory counts, progress toward the next observation and reflection, observer backlog, config warnings and the last worker errors.
- **`/om:view [full]`**: prints and copies the visible memory; `full` includes recorded memory the summary omits.

`/clear` starts a fresh memory floor: nothing from before it leaks into the new context.

## Compaction behavior

When omp compacts, omp-om decides in this order:

1. **Memory model unhealthy** (can't resolve, can't authenticate, request failed, 20 second deadline hit): warn and let omp's normal summarizer run.
2. **Ledger behind omp's cut:** the observer catches up, up to `compactionCatchUpMaxChunks` chunks. If the remaining tail fits, the cut moves back to keep it in context.
3. **Tail or summary doesn't fit the budget:** omp-om writes a deterministic summary from the ledger that fits plus excerpts of the unobserved input.
4. **Cancellation:** a user abort cancels compaction. A second compaction while one is running is cancelled as a duplicate.

A failed worker request discards its partial output and never advances coverage. The memory model is considered healthy again after the next worker request that completes successfully, even if it produces no records.

## Troubleshooting

Warnings appear only in sessions with a UI. Turn on `debugLog` to see the underlying events in other modes.

| Message | Cause and fix |
| --- | --- |
| `observer failed: memory model "…" did not resolve …` | Fix `model` or its credentials. omp uses normal compaction until a worker request succeeds. |
| `memory model unavailable: …` | Resolution or authentication failed before compaction. omp's normal compaction runs. |
| `memory work reached the 20s hook deadline` | Authentication or catch-up took too long. omp's normal compaction runs; late worker results are ignored. |
| `observer catch-up failed: …` | The catch-up request failed; the provider's reason is included. omp's normal compaction runs. |
| `observer has not reached …; keeping them in context until they are observed` | Info only: the cut moved back to retain unobserved conversation. |
| `no memory record fits the ~N-token summary budget; using a truncated model-free summary` | Raise `compactionSummaryMaxTokens`. |
| `compaction hook failed: …` | Unexpected error. omp's normal compaction runs. Enable `debugLog` and report it. |

Other checks:

- **No memory entries appear:** run `/om:status`, look for a worker error, and confirm `passive` is off.
- **Config seems ignored:** `/om:status` shows config warnings naming the offending file.
- **Shared cost with Mnemopi:** if Mnemopi's `llmMode` is `smol` and omp-om's `model` is `@smol`, both use the same model and share its cost and rate limits.

## Development

Requires Node.js 24. `src/` is the source of truth; `dist/index.ts` is the committed build output that omp loads, so rebuild before committing source changes.

```bash
npm ci
npm run typecheck
npm test
npm run build
```

[GitHub Actions](.github/workflows/ci.yml) runs the same commands on pushes, pull requests and manual dispatches. The tests use fixtures and simulated provider responses, so they need no model endpoint or API key.

## Based on pi-observational-memory

omp-om is a fork of [pi-observational-memory](https://github.com/elpapi42/pi-observational-memory) 3.1.4 by elpapi42, adapted to run on omp. It is MIT licensed. See [NOTICE.md](NOTICE.md) for the attribution and the original license text.

## License

MIT

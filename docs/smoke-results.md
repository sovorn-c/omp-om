# Smoke results: omp-om on omp 18.12.5

Date: 2026-10-21. Built with `npm run build`, loaded with `omp -e /Users/sovorn/dev/omp/plugin/omp-om`.

## Route

`omp -p` does not expand slash commands, so the runs used `omp --mode rpc` driven over stdin by a throwaway Node script in a scratch dir (`mktemp -d`, deleted afterwards). Per run: 5 prompts (about 15 s apart so background workers could run), then the RPC `compact` command, which is omp's manual compaction (the same path as `/compact`).

```
omp --mode rpc -e <omp-om> --session-dir <scratch>/sessX --config <scratch>/overlay.yml --cwd <scratch>/cwdX --no-lsp --no-title
```

- Session store: `--session-dir` pointed into the scratch dir. The session files were found there and nowhere in `~/.omp/agent/sessions`.
- Settings overlay: `--config overlay.yml` (`compaction.keepRecentTokens: 400`, `compaction.thresholdTokens: 100000`). The threshold was never reached, so auto-compaction was not exercised; compaction was the manual RPC `compact`.
- Config: `<scratch>/cwdX/.omp/omp-om.json` with `observeAfterTokens: 300`, `reflectAfterTokens: 600` (lowered so workers fire within a few turns). Run A `model: "@smol"`; run B `model: "nonexistent/does-not-exist"`.
- `~/.omp/config.yml` and `~/.omp/agent` settings were not edited. omp itself created Mnemopi memory banks keyed to the scratch cwds under `~/.omp/agent/memories/mnemopi/banks/`; those two bank dirs were removed afterwards.
- RPC mode has a UI, so `ctx.hasUI` was true and warnings arrived as `extension_ui_request` `notify` events.

## Bug found and fixed

First run A: every observer call failed with `observer stream ended with stopReason "error": undefined is not an object (evaluating 't.role')` and no `om.*` entries were written. Cause: the workers passed their system prompt as a `role: "system"` message in `AgentContext.messages`, but omp's `AgentContext` takes `systemPrompt: string[]`. Fixed in `a534b37` (observer, reflector, dropper; regression assertions in their tests).

## Results (after the fix)

1. **Workers call the model without `streamFn`: pass.** Session JSONL, run A:
   ```
   om.observations.recorded  2026-10-21T11:21:54.015Z   (observer, @smol)
   om.reflections.recorded   2026-10-21T11:21:58.753Z   (reflector)
   om.observations.recorded  2026-10-21T11:22:54.342Z
   om.observations.recorded  2026-10-21T11:23:33.183Z   (hook catch-up, 0.4 s before the compaction)
   ```
   Example observation: `[353e3771d729] User is building a Rust CLI called 'ledgerlite' that parses bank CSV exports.` Notices seen: `observer running on ~133-token chunk`, `4 observations recorded`, `reflector running`, `observing 4 unobserved source entries (~169 tokens) before compacting`.

2. **`compaction` entry whose summary is the ledger render: pass.**
   ```
   {"type":"compaction","firstKeptEntryId":"e03ae2da","tokensBefore":22273,"tokensAfter":19289,"fromExtension":true, details:{type:"om.folded",fullFold:false,...}}
   summary: "These are condensed memories from earlier in this session. ... ## Observations
   [353e3771d729] 2026-10-21 18:21 [high] User is building a Rust CLI called 'ledgerlite' ...
   ... (13 observations)"
   ```
   The summary names `om_recall` (renamed from `recall`). It has no `## Reflections` section: the reflection was recorded but is folded only on a full fold (`fullFold: false`), per `buildCompactionProjection`.

3. **No model call for summarization at compaction: pass.** Checked three ways: (a) the compaction entry has `fromExtension: true`, and in omp's `session-maintenance.ts` that is the hook branch; (b) the session has exactly one `model_usage` entry, `purpose: "memory"`, written 40 s before the compaction. `purpose: "memory"` is set only in omp's Mnemopi backend (`mnemopi/backend.ts:631`), not by omp-om or compaction; there is no usage entry with a compaction or summary purpose; (c) the last catch-up record (11:23:33.183) and the compaction entry (11:23:33.592) are 0.4 s apart, with no summarizer call between. Worker calls to `@smol` do not write `model_usage` entries, so this checks omp's summary path, not omp-om's own calls.

4. **Nonexistent `model`: pass.** Compaction completed (`compact` response `success: true`), `fromExtension: true`, no `om.*` entries, fallback summary:
   ```
   Observational memory (model-free fallback summary; no memory model was used).
   No observational memory was recorded for this session before this compaction; the earlier context is not summarized.
   13 source entries (~642 tokens) before this point were never observed, so no memory record describes them and they are no longer in context.
   Excerpts of the unobserved input:
   - Project context: I am building a Rust CLI called 'ledgerlite' ...
   ```
   Warnings received as `notify` (all `warning`):
   - `Observational memory: observer skipped — memory model "nonexistent/does-not-exist" did not resolve to an available model; set "model" in omp-om.json`
   - `Observational memory: memory model unavailable: memory model "nonexistent/does-not-exist" did not resolve to an available model; set "model" in omp-om.json; compacting without catching up the observer`
   - `Observational memory: observer has not reached 13 source entries (~642 tokens) before the compaction cut and they cannot be retained (no observation coverage); compacting with a model-free summary of the memory so far`

   Only one `model_usage` entry (`purpose: "memory"`, Mnemopi) and no summary call. These warnings need a UI; whether `-p` mode shows them was not tested.

5. **`om_recall` registered: pass.** The model read the tool's docs (`# om_recall — Recover exact evidence ...`) and called it with id `abc123def456`; the result was `No observation or reflection with id abc123def456 was found on the current branch.` `get_available_commands` listed `om:status` and `om:view`.

## Not covered

- Auto-compaction by threshold (only manual compact), the `extensions:` setting route, `/clear` and `reset_boundary`, the 20 s deadline path, `-p` mode warnings.
- `reflector running (~23,393 tokens)` appeared with a tiny ledger: stage progress is the larger of the raw estimate and provider-reported context growth, and omp's system prompt is large. Not investigated further.

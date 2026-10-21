# Smoke results: omp-om on omp 18.12.5

Date: 2026-10-21. Built with `npm run build`, loaded with `omp -e /Users/sovorn/dev/omp/plugin/omp-om`.

The results below describe the original implementation. Its outage behavior (result 4) is superseded by the native compaction handoff update; see the new verification section added for that update.

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
- `reflector running (~23,393 tokens)` appeared with a tiny ledger: with no coverage marker yet, the whole provider-reported context (omp's system prompt included) counted as growth. Fixed after the smoke run (`realTokensSinceAnchor` returns no baseline before the first record or compaction, so only the raw source estimate counts); covered by unit tests, not re-run live.

## Native compaction handoff update

Verified on 2026-10-21 after commit `438b684`, using isolated `omp --mode rpc` sessions. Both runs configured `magpie/codex/gpt-6-luna:medium` for the session and memory workers. A local forwarding proxy rejected any other model and enforced/logged medium effort for every forwarded request, including native summarization. There were 11 forwarded requests in the healthy run and 7 in the final outage run; failed memory requests used a separate closed localhost port.

The harness loaded a scratch copy of `src/` through an extension wrapper. Its only source change set `WORKER_THINKING_LEVEL` to `medium` for verification; production stays at `low` with the `@smol` model default. The fault wrapper preserved omp's original context and overrode only the memory auth result's `baseUrl`. Session/native requests kept the working endpoint. Built output was separately verified by `npm run build`.

Isolation: scratch `PI_CONFIG_DIR`, `PI_CODING_AGENT_DIR`, model registry, cwds and session directories; no real configuration writes. The overlay set `memory.backend: off`, `compaction.methodOrder: [soft]`, `compaction.keepRecentTokens: 100` and `compaction.thresholdTokens: 100000`. Routine progress notifications were enabled. Temporary harness files and processes were removed after verification.

| Scenario | Observed result |
| --- | --- |
| Healthy observer and compaction | Three `om.observations.recorded` entries containing four observations in the successful session. Manual RPC compaction succeeded with `fromExtension: true` and `details.type: "om.folded"`. |
| Memory endpoint refuses connections | Warning named the observer, configured Luna model and connection refusal, then stated memory updates stopped, conversation could continue and omp would use normal compaction. No observation records were appended. |
| Conversation after the warning | A new prompt completed successfully: `We chose **eu-west-1** and **Postgres 17**.` |
| Native compaction during outage | Manual RPC compaction succeeded with `fromExtension: false`, `method: "soft"` and no `om.folded` details. The native summary preserved eu-west-1, Postgres 17, immutable CSV sources and transaction-scoped import IDs. |

The initial harness attempts exposed test-driver issues: a proxy error handler sent headers twice after the client closed an SSE stream; a progress matcher missed singular `observation`; an invalid `compact` method name needed `soft`; spreading the host context lost getter-backed fields. These were harness changes, with no product workaround.

Final verification after review fixes: `npm run typecheck`, 33 test files / 368 tests, and `npm run build` passed. Six regression cases were observed failing before fixes: skipped reflector recovery, partial-output failures in all three workers, and the real observer failure through background and catch-up consumers. A standalone Bun smoke outside Vitest injected tool-output-then-provider-error events into all three real workers, confirmed each rejected its partial output, and confirmed an empty bounded reflector preserved the outage and native hook handoff. These simulated provider events did not make live inference requests.

Regression coverage also includes unresolved/auth-failed models, covered ledgers with catch-up disabled, persistent outage and successful recovery, throwing UI, concurrent failure during preflight, hook deadlines, user cancellation and late-write protection. Live recovery after reconnect, auto-compaction, deadline expiry and headless warning display were not exercised.


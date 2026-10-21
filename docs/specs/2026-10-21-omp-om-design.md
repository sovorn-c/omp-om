# omp-om design

Status: DRAFT. Design only, no code. Not yet reviewed by a builder check or approved.
Date: 2026-10-21

Evidence tags used below:
- **[docs]** read in omp's docs
- **[src]** read in omp source, `@oh-my-pi/*` v18.8.7 installed at `~/node_modules/@oh-my-pi` (the `omp` binary is 18.12.5, so drift is possible)
- **[pom]** read in the Pi OM clone, `pi-observational-memory`
- **[cfg]** read in `~/.omp/agent/config.yml`
- **[?]** not verified; to be settled by the spike
- **[call]** a decision made by the assistant, not by the user

## 1. Intent

Port [`pi-observational-memory`](https://github.com/elpapi42/pi-observational-memory) (Pi OM) to omp as a plugin named `omp-om`.

Pi OM runs three background workers (observer, reflector, dropper) that write a ledger of observations into the session journal. When the host compacts, a hook renders that ledger as the compaction summary. The host makes **no LLM call to summarize**. Memory is built incrementally in the background instead of in one big summary at compaction time.

Why: the user wants compaction to be a cheap render step, with a durable structured memory that survives it.

## 2. Goals, non-goals, anti-goals

Goals
- Same behavior as Pi OM on omp: background ledger, compaction summary rendered from it.
- One config file, one `model` key, like Pi OM.
- Work with omp's native compaction without the user hand-tuning it.

Non-goals
- Bridging reflections into Mnemopi's `retain` (deferred, not v1).
- Replacing or disabling omp's compaction.
- Supporting Pi itself. This is an omp plugin.

Anti-goals (a failure even if it technically works)
- omp making its own LLM summary call at compaction because the hook declined.
- A design where the user must edit `compaction.*` settings to make it work.

## 3. How compaction works in omp (what the design rests on)

All from `session-maintenance.ts` **[src]** unless noted.

1. omp decides to compact (threshold, overflow, idle, manual `/compact`) and picks the first usable method from `compaction.methodOrder` (`remote`, `snapcompact`, `handoff`, `soft`, `shake`) (`:4312-4351`).
2. Unless the method is `shake` (which runs inline *before* any hook, `:4369`), omp emits `session_before_compact` (`:4631`).
3. If the hook returns `{compaction}`, omp takes the `fromHook` branch (`:4845`). Handoff and snapcompact generation are skipped (`:4667`, `:4724`), and the only `compact(...)` LLM call sits in the `else` branch (`:4867-4960`), which is not reached. Net: **no summary call**.
4. If the hook returns `{cancel}`, compaction aborts (`:4640`). If it returns nothing, omp runs the chosen method normally, which for `remote`/`handoff`/`soft` is an LLM summary.
5. Speculative background compaction is disabled while any extension registers `session_before_compact` (`:2081`, `:2174`, `:2387`).
6. `compaction.experimentalContextManagement: true` returns before the hook (`:4292`).
7. `compaction.enabled: false` makes auto-compaction return early for all reasons except idle (`:4289`).

`soft` and `shake` are always "usable", `soft` comes before `shake` in the user's order, so `shake` is never selected **[src, cfg]**. The user's `methodOrder` is `remote, handoff, snapcompact, soft, shake` **[cfg]**.

## 4. Decisions

### D1. Leave omp compaction on and use the hook (as Pi OM does)
- `compaction.enabled` stays `true`. Turning it off removes threshold and overflow recovery, and omp-om would have to trigger compaction itself.
- No `compaction.methodOrder` change is required. `experimentalContextManagement` must stay off (it is off by default, and off in the user's config).
- The plugin never edits user settings.

### D2. The hook never declines
Pi OM's `handleCompaction` returns `undefined` (handing the job to omp's LLM summarizer) in these cases **[pom `hooks/compaction-hook.ts`]**:
- the observer is behind the cut and the unobserved tail cannot be retained within budget (`:258-266`)
- no coverage marker exists yet, so catch-up is skipped (`:177`)
- the ledger is empty or no record fits the summary budget (`:209-222`, `:269-272`)

omp-om replaces each with a local outcome:
1. Catch up even with no marker, observing from the start of the branch, under a hook deadline (below).
2. If the observer cannot cover the gap (not reached, timed out, model unresolved, no credentials), skip further observing and reflecting, render the ledger so far, and keep the unobserved tail in context.
3. If that still does not fit the retained budget, return a minimal deterministic summary built without a model.

**Hook deadline (user decision, 2026-10-21).** omp aborts an extension handler after 30s **[docs/src, per builder check]**. Catch-up gets a hard ~20s deadline; the user's judgement is that 20s is enough for a small model to reach the cut. When the deadline passes, the model is unset or unresolvable, or the observer otherwise did not reach the cut, the hook does no further observe or reflect work and shows a **warning** (when the session has a UI) naming the cause, so the user knows setup is missing or the observer is lagging. It then falls through to outcome 2 or 3. The hook never throws and never returns `undefined`.

Open: the exact shape of the minimal deterministic summary and the budget arithmetic **[?]**. The 20s value is configurable in code, not in `omp-om.json` **[call]**.

### D3. Compaction trigger is omp's, not omp-om's
Pi OM triggers compaction itself from `agent_settled` using `compactAfterTokens` (default 81,000) **[pom `config.ts:123`]**. omp has no `agent_settled` event **[docs extensions.md]**.

- omp-om drops `agent_settled` and `consolidateWhenIdle` (default off in Pi OM, `config.ts:131`).
- omp's own threshold decides when compaction fires. The user's is `thresholdTokens: 150000` (a positive value wins over `thresholdPercent: 60`) **[cfg, docs settings.md]**.
- `compactAfterTokens`, `compactAfterTokensMode` and `compactAfterTokensRatio` are removed from the config **[call]**.
- Constraint: `observeAfterTokens` < `reflectAfterTokens` < omp's compaction threshold, so the ledger is ahead of the cut when omp compacts.

### D4. Configuration
- File: `~/.omp/agent/omp-om.json`, located via `getAgentDir()` (exported by omp's shim **[src]**). omp has no place for plugin keys in `config.yml` **[call]**.
- Optional project override `<cwd>/.omp/omp-om.json`, merged over the global file **[call]**.
- Single model key, like Pi OM: one `model` for observer, reflector and dropper. No per-worker overrides (user decision).
- `model` accepts `provider/id[:thinking]`, a bare id, or a role alias such as `@smol`, resolved with `ctx.models.resolve(spec)` **[docs extensions.md]**.
- Default `model` is `@smol` **[call]**. The user's `smol` is `magpie/claude/claude-haiku-5-5:high` **[cfg]**.
- If the model cannot be resolved or has no credentials, workers skip and log. They never block compaction **[call]**.
- Pi OM defaults carried over: `observeAfterTokens: 10_000`, `reflectAfterTokens: 20_000`, `compactionCatchUpMaxChunks: 2` **[pom `config.ts:121-130`]**.

```jsonc
// ~/.omp/agent/omp-om.json
{ "model": "@smol" }
```

Note: the user's `mnemopi.llmMode: smol` **[cfg]** means Mnemopi also calls `smol`. Both share that model's cost and rate limits.

### D5. Tool rename
Pi OM's `recall` tool becomes `om_recall`, because Mnemopi already registers `recall` in omp.

### D6. Host imports
Keep Pi OM's imports (`@earendil-works/pi-coding-agent`, `pi-ai`, `pi-ai/compat`, `pi-agent-core`). omp's loader rewrites `@earendil-works/*` and `@mariozechner/*` onto the host copies, and maps `pi-ai/compat` to `pi-ai` **[docs extension-loading.md, src `legacy-pi-compat.ts:839`]**. Per symbol **[src]**:

| Symbol | Result |
|---|---|
| `streamSimple` via `pi-ai/compat` | re-exported by `legacy-pi-ai-shim.ts` |
| `agentLoop(prompts, context, config, signal?, streamFn?)` | exported from `@oh-my-pi/pi-agent-core`, `agent-loop.ts:620` |
| `modelRegistry.getApiKeyAndHeaders`, `isUsingOAuth` | exist on `ModelRegistry`, `model-registry.ts:3022`, `:3117` |
| `sessionEntryToContextMessages` | exported by `legacy-pi-coding-agent-shim.ts:1564` |

Pi OM's `worker-stream.ts` workaround (Pi issue #30) is dropped: with no `streamFn`, `agentLoop` uses `streamSimple`, which checks `getCustomApi(model.api)` first (`stream.ts:1470`).

Open **[?]**: whether the extension-facing `ctx.modelRegistry` exposes `getApiKeyAndHeaders`; omp returns `ok:false` for a missing key where Pi OM special-cases `{ok:true, apiKey:undefined}` (`runtime.ts:~215`).

### D7. Session entries and the progress counter
Pi OM counts `message`, `custom_message`, `branch_summary` as source entries and stores `custom` markers with `customType: "om.*"` and `data.coversUpToId` **[pom `session-ledger/progress.ts`]**. All exist in omp **[docs session.md]**, `custom` entries never enter LLM context **[src `session-entries.ts:177`]**, usage has `input/output/cacheRead/cacheWrite/totalTokens` and `StopReason` includes `error`/`aborted` **[src]**, matching `contextTokensFromUsage`.

Decided **[call]**: `/clear` appends a `reset_boundary` entry **[docs session.md]** and Pi OM does not handle it. omp-om treats the latest `reset_boundary` as a floor: entries at or before it are ignored for catch-up, coverage and the rendered summary, so memory from before `/clear` does not leak into a fresh context.

### D8. Licensing
Fork of Pi OM. License is MIT (`LICENSE`, `package.json`) **[pom]**. Keep the copyright notice and add attribution.

## 5. Out of scope for v1
- Mnemopi bridging (retaining reflections via `retain`).
- Any change to omp settings by the plugin.

## 6. Limit to state plainly
"No summary" means no LLM call at compaction time. The observer, reflector and dropper still call the configured model in the background, in small increments. For zero model calls, skip omp-om and use omp's native `snapcompact` + `shake`.

## 7. Open questions
1. Shape of the deterministic fallback summary (D2).
2. ~~`reset_boundary` handling~~ decided in D7 (assistant's call, user may override).
3. `ctx.modelRegistry.getApiKeyAndHeaders` on the extension facade, and the `ok`/`apiKey` semantics (D6).
4. Whether Pi OM loads and its hook fires on omp 18.12.5 unchanged. Settled by the spike: load Pi OM via `omp -e` from a scratch cwd, nothing written to `~/.omp`.
5. Whether the user's active model (`magpie/claude/claude-sonnet-5-5`) accepts images. Only relevant to `snapcompact`; not required by this design.

# Spike notes: unmodified Pi OM 3.1.4 on omp

Date: 2026-10-21. Fork baseline at `package.json` version 0.1.0, source unchanged from pi-observational-memory 3.1.4 (commit `022da5e`).

## (a) omp version

```
$ omp --version
omp/18.12.5
```

## (b) Does the unmodified fork load?

Yes. `npm run build` produced `dist/index.ts` (178250 bytes), then from a scratch dir created with `mktemp -d`:

```
$ omp -e /Users/sovorn/dev/omp/plugin/omp-om -p "say hi" --no-session
Working...
Hi!
```

No import, resolve, or other error was printed. `@earendil-works/*` imports are external in the bundle and resolved through the host with no complaint.

Evidence the extension was actually registered, not silently skipped: running `omp -e <omp-om> -p "/om-status" --no-session` made the model answer that the `recall` tool's description mentions `/om:view`. That text is the fork's `recall` tool description (`src/tools/recall-observation.ts`), so the tool was registered on omp. The fork's commands are `om:status` and `om:view`; `-p` mode does not expand slash commands, so command registration was not exercised directly.

## (c) Model registry methods at runtime (design open question 3)

Probed with a throwaway extension (in the scratch dir, deleted afterwards) that logged on `session_start`, run as `omp -e ./probe.ts -p hi --no-session`:

```
typeof ctx.modelRegistry = object
typeof getApiKeyAndHeaders = function
typeof isUsingOAuth = function
```

Both `ctx.modelRegistry.getApiKeyAndHeaders` and `ctx.modelRegistry.isUsingOAuth` exist at runtime on omp 18.12.5. The `modelRegistry` prototype also exposes `getApiKey`, `getApiKeyForProvider`, `getApiKeyWithCredentialForProvider`, `find`, `getAll`, `getAvailable`, `getProviderModels`, and others (the probe output truncated the list after `isU…`).

The context object's own enumerable keys were only `ui` (`Object.keys(ctx)`); the other members, such as `modelRegistry` and `models`, are non-enumerable or on the prototype.

## (d) `ctx.models.resolve`

```
typeof ctx.models = object
typeof ctx.models.resolve = function
```

`ctx.models.resolve` exists on omp 18.12.5.

## (e) `ctx.models.resolve` and `getApiKeyAndHeaders` return shapes (Task 2)

Checked against omp's docs, its source (`src/extensibility/extensions/model-api.ts`, `config/model-registry.ts`), and a throwaway probe extension (scratch dir from `mktemp -d`, run as `omp -e ./probe.ts -p hi --no-session`, deleted afterwards) on omp 18.12.5.

`ctx.models` exposes `list()`, `current()`, `resolve(spec)` and `family(model)`.

- `ctx.models.resolve(spec)` is **synchronous** and returns `Model | undefined`. The docs say "Returns `undefined` when nothing matches." It calls `resolveModelRoleValue(spec, modelRegistry.getAvailable(), ...)`, so it only matches **available (authenticated)** models and expands role aliases. It does not throw for unknown specs.

  | spec | result |
  | --- | --- |
  | `@smol` | model object (`magpie/claude/claude-haiku-5-5` on the probe host) |
  | `nonsense/does-not-exist` | `undefined` |
  | `@nosuchrole` | `undefined` |
  | `""` | `undefined` |

- `ctx.modelRegistry.getApiKeyAndHeaders(model)` returns a promise of `{ ok: true, apiKey?, headers?, env? }` or `{ ok: false, error }` (`ResolvedRequestAuth`, `config/model-registry.ts:247`). It catches internally and does not throw. The probe returned keys `["ok","apiKey","headers"]` with a string `apiKey`. Providers that need no key get the sentinel `apiKey` `"N/A"`, a non-empty string, so `resolveCandidate` counts it as usable auth. The omp shape has no `baseUrl`; the `auth.baseUrl` read in `resolveCandidate` is harmless.
- `ctx.modelRegistry.isUsingOAuth(model)` returns a boolean. `hasConfiguredAuth(model)` also exists (`model-registry.ts:2836`).

Consequence for omp-om: `Runtime.resolveModel` calls `ctx.models.resolve(config.model)`, treats a falsy result as "model unavailable" (`{ ok: false, reason }`), and wraps both calls in try/catch so a surprise throw still becomes `ok: false`. Workers skip rather than block.

## Notes

- `session_start` was probed for (c) and (d). Return shapes are recorded in (e).
- Nothing under `~/.omp` was edited; all runs used `--no-session`.

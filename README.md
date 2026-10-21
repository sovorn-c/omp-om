# omp-om

Observational memory for omp. It keeps a structured ledger of what happened in a session and renders that ledger as the compaction summary, so compaction does not need an LLM summary call.

## What it does

While you work, three background workers write to the session journal:

- **Observer**: distills new conversation into timestamped observations.
- **Reflector**: distills durable reflections from observations.
- **Dropper**: drops observations that reflections already cover, to keep the pool small.

When omp compacts, omp-om's `session_before_compact` hook renders the ledger as the compaction summary and returns it to omp. omp then skips its own summarizer. The hook never returns `undefined` and never declines, so omp's native summarizer is not used while omp-om is loaded. If the ledger is behind, the hook catches the observer up under a 20 second deadline. If that is not possible, it renders what it has, or a minimal model-free summary, and shows a warning when the session has a UI.

## The honest limit

"No summary" means no LLM call **at compaction time**. The observer, reflector and dropper still call the configured `model` in the background, in small increments. If you want zero model calls, do not use omp-om; use omp's native `snapcompact` + `shake` instead.

## Install

Load it for one run:

```bash
cd /path/to/omp-om && npm install && npm run build
omp -e /path/to/omp-om
```

Or load it on every run with the `extensions` setting in omp's `config.yml` (an array of paths; the setting is `extensions` in omp's settings registry):

```yaml
extensions:
  - /path/to/omp-om
```

`package.json` points both `pi.extensions` and `omp.extensions` at `./dist/index.ts`. `src/` is the source of truth; run `npm run build` after editing it, and commit `dist/`.

I exercised the `omp -e` route (see [docs/smoke-results.md](docs/smoke-results.md)). The `extensions:` setting route is documented from omp's source and was not exercised.

omp-om never edits omp settings. omp's compaction stays on; omp's own threshold decides when compaction fires. Keep `observeAfterTokens` < `reflectAfterTokens` < omp's compaction threshold so the ledger is ahead of the cut.

## Configuration

One file, `omp-om.json`:

- Global: `<agent dir>/omp-om.json`, normally `~/.omp/agent/omp-om.json`.
- Project override: `<cwd>/.omp/omp-om.json`, merged over the global file.
- `PI_OBSERVATIONAL_MEMORY_PASSIVE` (`1`/`true`/`yes`/`on` or `0`/`false`/`no`/`off`) overrides only `passive`.

The minimal file:

```json
{ "model": "@smol" }
```

`model` is the single memory model for the observer, reflector and dropper. It accepts anything omp's `ctx.models.resolve` accepts: `provider/id`, a bare id, or a role alias such as `@smol`. The default is `@smol`. There are no per-worker overrides.

Defaults that are kept:

| Key | Default |
| --- | --- |
| `observeAfterTokens` | `10000` |
| `reflectAfterTokens` | `20000` |
| `observationsPoolMaxTokens` | `20000` |
| `observationsPoolTargetTokens` | half of `observationsPoolMaxTokens` |
| `agentMaxTurns` | `16` |
| `agentMaxTokens` | `32000` |
| `compactionCatchUpMaxChunks` | `2` |
| `showWorkerNotifications` | `true` |
| `passive` | `false` |
| `debugLog` | `false` |

See [docs/usage.md](docs/usage.md) for every key, the derived budgets, the fallback ladder and troubleshooting.

## Tool and commands

- Tool `om_recall`: recovers the source evidence behind an observation or reflection id (12-character lowercase hex id shown in the summary or in `/om:view`). Pi OM's `recall` was renamed because Mnemopi already registers `recall` in omp.
- `/om:status`: shows memory counts, progress toward the next observation and reflection, and observer backlog.
- `/om:view [full]`: prints and copies the visible memory; `full` includes recorded memory that the summary omits.

## Based on pi-observational-memory

omp-om is a fork of [pi-observational-memory](https://github.com/elpapi42/pi-observational-memory) 3.1.4 by elpapi42, adapted to run on omp. It is MIT licensed. See [NOTICE.md](NOTICE.md) for the attribution and the original license text.

## License

MIT

# Native compaction fallback design

## Intent

When omp-om cannot use its configured memory model, warn the user, stop the failing observation/reflection pass, and leave normal omp conversation running. During this outage, return no compaction override so omp uses its normal compaction. Native summarization is omp's responsibility. This supersedes the original design's unconditional hook override on failure.

## Contract

- Background resolution/authentication errors and observer, reflector or dropper request failures mark memory work unavailable and emit a UI warning naming the phase, configured model and cause. Explain that memory updates stopped, conversation can continue, and compaction will use omp's normal summarizer. Notification failures cannot escape the worker task.
- Keep the outage state across new worker launches. A later normally scheduled worker pass may retry; there is no new timer, permanent disable switch or retry loop. A successful worker request clears the shared outage state, even if it deliberately produces no records. This is the implementation choice because all workers use one model.
- While a known outage remains, the compaction hook warns and returns `undefined` immediately, without cancelling or starting another memory request.
- With no known outage, check model resolution/authentication before supplying a ledger summary, including when coverage is complete or catch-up is disabled. Resolution alone cannot clear an existing outage.
- Catch-up request errors, unavailable models, the 20,000 ms deadline, and unexpected hook errors warn and return `undefined`. A user abort still returns `{ cancel: true }`; duplicate compaction remains cancelled. Bound the entire asynchronous hook, including auth lookup, by the existing 20,000 ms deadline. Prevent late writes after deadline/abort.
- Healthy memory behavior stays intact: catch-up, retention of a safe tail, budget handling, ledger rendering and successful model-free budget fallback remain available. An intentional empty result or chunk cap is not a provider failure.
- Existing memories remain in the journal. No stored format, new config, native compaction settings or native summarizer changes.
- Every live model request used for verification must use `magpie/codex/gpt-6-luna:medium`. Simulate an unreachable memory endpoint for outage verification while keeping the same configured model. Do not edit real ~/.omp configuration, create/delete real memory banks, or touch unrelated files.

## Verification

Regression tests cover persistent outage and recovery, observer/reflector resolution/request failures, disabled informational notifications, throwing UI notifications, covered-ledger unresolvable model, native handoff, hook errors, hanging auth, deadline/abort races, and suppression of late writes. Existing healthy compaction tests remain green. A scratch RPC smoke proves a successful observer and ledger compaction, a failed memory request with UI warning, continued conversation, and native compaction with no extension override. Use isolated session/config/storage and disable native memory in the overlay.

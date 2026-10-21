# Native compaction fallback implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Warn when omp-om memory work fails and delegate compaction to omp until a worker succeeds again.

**Architecture:** Keep a shared in-memory outage reason in Runtime. Background stages set it on failure and clear it on a successful request. The compaction hook checks health, resolves the model, and returns undefined on failure under its existing bounded deadline.

**Tech Stack:** TypeScript, Vitest, npm build, omp RPC.

**Spec:** docs/specs/2026-10-21-native-compaction-fallback-design.md

## Global Constraints

- Single configured memory model; keep @smol as the product default.
- Every live verification model request uses magpie/codex/gpt-6-luna:medium.
- No real ~/.omp configuration or memory-bank mutations; use scratch RPC sessions and disable native memory in the overlay.
- No new config keys, dependencies or persistent journal formats.
- Native summarizer behavior is omp's responsibility; return undefined to delegate.
- User explicitly requested planning followed by implementation; execute continuously in this checkout. Existing main-branch authorization applies.

## Review Focus

- Known failure persists across launch and successful model resolution; only a successful worker request recovers it.
- Fully covered ledger, disabled catch-up and failed auth still delegate to native compaction.
- UI notify throwing must not break normal conversation or fallback.
- Timeout covers auth lookup and late worker results cannot append after delegation.
- User cancellation wins over delegation; intentional empty/chunk limit stays healthy.

---

### Task 1: Worker outage state and native compaction handoff

**Review:** per-task — concurrency (implemented inline; final reviewer examines this task in full).

**Files:**
- Modify: src/runtime.ts, src/hooks/consolidation-trigger.ts, src/hooks/compaction-hook.ts, src/hooks/compaction-catch-up.ts
- Test: tests/runtime.test.ts, tests/consolidation-trigger.test.ts, tests/compaction-hook.test.ts, tests/compaction-catch-up.test.ts

**Interfaces:**
- Runtime.memoryFailureReason: string | undefined; shared model outage, independent of last-phase diagnostic fields.
- Runtime.recordConsolidationStageError(ctx, phase, error): string also marks outage and warns safely.
- HookResult adds undefined for native handoff, retaining compaction and cancel variants.
- CatchUpArgs accepts the pre-resolved successful ResolveResult so preflight and catch-up do not resolve/authenticate twice.

- [ ] Step 1: Add regression tests for persistent outage across launch, warning despite disabled info notifications, throwing notification handlers, recovery after a successful worker call, and resolver success alone not clearing failure. Existing worker failures assert no later stages or bogus coverage.
- [ ] Step 2: Run npx vitest run tests/runtime.test.ts tests/consolidation-trigger.test.ts; observe expected assertion failures before implementation.
- [ ] Step 3: Implement shared outage tracking, safe actionable warnings and normal scheduled recovery. Resolve failures use the same failure recorder; successes clear memoryFailureReason only after a worker request completes. Preserve failure when launch starts.
- [ ] Step 4: Add hook tests that assert undefined for known worker outage, failed resolution with complete coverage/disabled catch-up, catch-up exception, deadline and unexpected hook error; assert cancellation and no late appends. Remove obsolete fallback assertions for model failure, retaining healthy budget fallback coverage.
- [ ] Step 5: Run npx vitest run tests/compaction-hook.test.ts tests/compaction-catch-up.test.ts; observe expected failures.
- [ ] Step 6: Implement bounded whole-hook preflight and native handoff. Pass resolved model into catch-up; propagate error reason; keep caller abort and late-write guards. Warnings explain native fallback. Budget-only fallbacks remain unchanged.
- [ ] Step 7: Run npm run typecheck && npm test && npm run build. Expected all pass. Commit source, tests and generated dist/index.ts by explicit paths.

### Task 2: Live proof and documentation

**Files:**
- Modify: README.md, docs/usage.md, docs/smoke-results.md

**Interfaces:** consumes Task 1 outage state and native handoff behavior; produces documented live evidence.

- [ ] Step 1: Inspect omp CLI/RPC and config interfaces, then use a throwaway scratch script to launch omp with isolated sessions, native memory disabled, and magpie/codex/gpt-6-luna:medium for session, memory and compaction requests. Verify successful observer records and extension-provided compaction.
- [ ] Step 2: In the same isolated harness force the memory model's endpoint to an unreachable local port (leave session/native resolution untouched). Assert the warning, successful next user turn, and native compaction without fromExtension/om.folded. Assert no failing observation coverage was appended.
- [ ] Step 3: Document actual results and limits; rewrite current README/usage claims about never declining and outage fallback. Record the original smoke as historical behavior superseded by this update.
- [ ] Step 4: Remove throwaway scripts/processes. Run full checks only again if code changes. Commit documentation by explicit paths.
- [ ] Step 5: Fresh sdd-final-reviewer reviews all changes, especially concurrency and Review Focus. Fix Important/Critical findings with failing-before/passing-after tests, rebuild, and run full suite. Keep work on the authorized main branch; do not push or publish.

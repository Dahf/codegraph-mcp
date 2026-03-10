---
phase: "07-fix-oom-memory-problem-when-indexing-very-large-repos"
plan: "07-02"
subsystem: "indexer"
tags: ["checkpoint", "memory-monitor", "progress-emitter", "tdd", "falkordb", "streaming"]
dependency_graph:
  requires: []
  provides:
    - "src/indexer/checkpoint.ts — readCheckpoint/writeCheckpoint/clearCheckpoint"
    - "src/indexer/memory-monitor.ts — MemoryMonitor class"
    - "src/indexer/progress.ts — IndexProgressEmitter + IndexProgressEvents"
  affects:
    - "src/indexer/pipeline.ts — will consume all three modules in 07-04"
tech_stack:
  added:
    - "vitest ^4.0.18 (devDependency) — test runner for the indexer modules"
  patterns:
    - "FalkorDB MERGE pattern for upsert checkpoint nodes"
    - "v8.getHeapStatistics() for true heap ceiling (not process.memoryUsage())"
    - "EventEmitter typed subclass with constrained on()/emit() overrides"
    - "TDD RED-GREEN cycle for all three modules"
key_files:
  created:
    - "src/indexer/checkpoint.ts"
    - "src/indexer/memory-monitor.ts"
    - "src/indexer/progress.ts"
    - "src/indexer/__tests__/checkpoint.test.ts"
    - "src/indexer/__tests__/memory-monitor.test.ts"
    - "src/indexer/__tests__/progress.test.ts"
  modified: []
decisions:
  - "Checkpoint uses FalkorDB MERGE — safe to call writeCheckpoint multiple times without creating duplicate nodes"
  - "MemoryMonitor timer uses unref() immediately after setInterval — prevents test runner and process hangs (Pitfall 5 from research)"
  - "stop() resolves pending drain promises — callers are never left waiting during shutdown"
  - "IndexProgressEmitter uses EventEmitter subclass with typed on()/emit() overrides — zero dependencies, full TypeScript type safety"
  - "Low-water mark for resume is 70% of threshold (thresholdRatio * 0.70) — matches research Pattern 3 exactly"
metrics:
  duration: "6 min"
  completed_date: "2026-03-10"
  tasks_completed: 2
  files_created: 6
  tests_added: 29
---

# Phase 07 Plan 02: Checkpoint, Memory Monitor, and Progress Emitter Summary

**One-liner:** FalkorDB MERGE-based checkpoint module, v8 heap-monitoring MemoryMonitor class with pause/resume and unref(), and typed IndexProgressEmitter — three self-contained utility modules consumed by the streaming pipeline in 07-04.

## Tasks Completed

| # | Task | Commit | Files |
|---|------|--------|-------|
| 1 | Checkpoint module for FalkorDB-based resume tracking | a4d1c7e | checkpoint.ts, __tests__/checkpoint.test.ts |
| 2 | Memory monitor and typed progress emitter | 33ea8c4 | memory-monitor.ts, progress.ts, __tests__/memory-monitor.test.ts, __tests__/progress.test.ts |

## Verification

All 29 tests pass across three test files:

```
✓ src/indexer/__tests__/checkpoint.test.ts     (11 tests)
✓ src/indexer/__tests__/memory-monitor.test.ts  (8 tests)
✓ src/indexer/__tests__/progress.test.ts       (10 tests)
```

TypeScript type check: no errors in the new modules (`tsc --noEmit` errors are limited to pre-existing 07-01 RED-phase test stubs and are out of scope).

## Decisions Made

1. **FalkorDB MERGE for checkpoint upsert** — `MERGE (c:Checkpoint {repoId: $repoId}) SET c.processedFiles = $files` is safe to call repeatedly without duplicating nodes. Matches Pattern 4 from research exactly.

2. **timer.unref() immediately after setInterval** — Prevents the MemoryMonitor's interval from keeping the Node.js process alive after pipeline completes. Critical for test environments where hanging prevents suite completion.

3. **stop() resolves pending drainResolvers** — If the pipeline calls `monitor.stop()` while a file-processing loop is blocked on `waitIfPaused()`, the blocker resolves cleanly rather than hanging indefinitely.

4. **Typed EventEmitter subclass** — `IndexProgressEmitter` overrides `on()` and `emit()` with `K extends keyof IndexProgressEvents` constraint. Payload types are inferred at call site — no casts needed by consumers.

5. **Low-water mark = thresholdRatio * 0.70** — Resume threshold is 70% of the pause threshold. Prevents thrashing where heap oscillates around the pause level, repeatedly pausing and resuming.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Test infinite-loop with vi.runAllTimersAsync()**
- **Found during:** Task 2 GREEN phase
- **Issue:** First memory-monitor test used `await vi.runAllTimersAsync()` which triggered vitest's 10,000-timer abort because MemoryMonitor's setInterval runs indefinitely.
- **Fix:** Replaced `runAllTimersAsync()` with direct `await monitor.waitIfPaused()` — waitIfPaused() returns a resolved Promise immediately when not paused, so no timer advancement is needed.
- **Files modified:** `src/indexer/__tests__/memory-monitor.test.ts`
- **Commit:** 33ea8c4 (same task commit)

**2. [Rule 2 - TypeScript] Test mock type casts needed unknown intermediate**
- **Found during:** Task 2 tsc check
- **Issue:** `v8 as { getHeapStatistics: ReturnType<typeof vi.fn> }` caused TS2352 overlap error; checkpoint test row type caused TS2353.
- **Fix:** Added `as unknown as` intermediate casts in test files — standard pattern for mock objects that intentionally diverge from production types.
- **Files modified:** `src/indexer/__tests__/memory-monitor.test.ts`, `src/indexer/__tests__/checkpoint.test.ts`
- **Commit:** Task 1 commit (checkpoint test fix) and 33ea8c4 (memory-monitor fix)

## Self-Check: PASSED

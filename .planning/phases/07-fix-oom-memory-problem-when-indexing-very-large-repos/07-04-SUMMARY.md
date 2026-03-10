---
phase: 07-fix-oom-memory-problem-when-indexing-very-large-repos
plan: "04"
subsystem: indexer
tags: [pipeline, streaming, p-queue, memory-monitor, checkpoint, falkordb, two-pass]

# Dependency graph
requires:
  - phase: 07-fix-oom-memory-problem-when-indexing-very-large-repos
    plan: "01"
    provides: async generator walkRepo, config schema with indexer.* fields
  - phase: 07-fix-oom-memory-problem-when-indexing-very-large-repos
    plan: "02"
    provides: checkpoint functions, MemoryMonitor, IndexProgressEmitter
  - phase: 07-fix-oom-memory-problem-when-indexing-very-large-repos
    plan: "03"
    provides: writeFileSymbols, writeCallEdges, clearGraph, createGraphIndexes, embedSingleChunk, storeEmbeddingRows
provides:
  - Streaming two-pass IndexPipeline that processes one file at a time (no allSymbols[] or sourceTexts Map)
  - Bounded embedding queue via p-queue with onSizeLessThan backpressure
  - Checkpoint-based resume (fresh vs resume branching via run({ resume? }) option)
  - Memory-safe per-file source text GC (nulled after extractChunks)
  - Route handlers with ?resume=true query param and console-logged progress events
  - Deprecated writeGraph and embedAndStore removed from codebase
affects:
  - Phase 08 (if added): any pipeline consumer, HTTP index endpoints, progress dashboard

# Tech tracking
tech-stack:
  added: [p-queue (already installed, now actively used in pipeline)]
  patterns:
    - Streaming generator pipeline with per-file processing (no bulk accumulation)
    - Two-pass call-graph: Pass 1 writes symbols, Pass 2 resolves callees via UNWIND FalkorDB query
    - Bounded queue via onSizeLessThan before enqueue, onIdle before drain
    - Checkpoint MERGE upsert after each file for crash recovery

key-files:
  created:
    - src/indexer/__tests__/pipeline.test.ts
  modified:
    - src/indexer/pipeline.ts
    - src/http/routes/index.ts
    - src/indexer/graph-writer.ts
    - src/indexer/embedder.ts
    - src/indexer/__tests__/graph-writer.test.ts
    - src/indexer/__tests__/embedder.test.ts

key-decisions:
  - "Pass 2 call-site resolution uses single UNWIND query per file (not one FalkorDB round-trip per call site) — O(1) queries per file instead of O(call_sites)"
  - "resume=false (default) always calls clearGraph + clearCheckpoint before processing — identical behavior to old pipeline on normal runs"
  - "Source text nulled immediately after extractChunks to allow GC before next file's processing begins"
  - "progressEmitter is optional constructor param — routes create a new emitter per request to isolate event streams"
  - "Deprecated writeGraph and embedAndStore removed together with their backward-compat test suites"

patterns-established:
  - "Two-pass streaming: Pass 1 streams for symbols+embeddings, Pass 2 streams for call-graph edges"
  - "Per-file checkpoint write enables crash recovery without reprocessing completed files"
  - "Embedding queue backpressure: await onSizeLessThan(limit) before each batch enqueue"

requirements-completed: []

# Metrics
duration: 12min
completed: 2026-03-10
---

# Phase 7 Plan 4: Streaming Pipeline Refactor Summary

**Two-pass streaming IndexPipeline with p-queue backpressure, MemoryMonitor integration, and checkpoint resume — eliminates allSymbols[], allTrees[], and sourceTexts Map OOM accumulation**

## Performance

- **Duration:** 12 min
- **Started:** 2026-03-10T11:00:00Z
- **Completed:** 2026-03-10T11:12:00Z
- **Tasks:** 3
- **Files modified:** 6

## Accomplishments

- Rewrote `IndexPipeline.run()` from all-in-memory bulk processing to file-at-a-time streaming with two-pass call-graph resolution
- Integrated `MemoryMonitor.waitIfPaused()` before each file in Pass 1 and p-queue with `onSizeLessThan` backpressure for bounded embedding queue
- Added checkpoint-based resume (`resume=true` option) and wired progress events to route handlers with `?resume=true` query parameter support
- Removed deprecated `writeGraph` and `embedAndStore` bulk functions (and their test suites) — codebase is clean

## Task Commits

Each task was committed atomically:

1. **Task 1: Refactor IndexPipeline.run() to streaming two-pass architecture** - `20964b5` (feat)
2. **Task 2: Update route handlers for resume support and progress emitter wiring** - `b86f832` (feat)
3. **Task 3: Remove deprecated bulk functions and clean up** - `ee15e43` (feat)

**Plan metadata:** (docs commit follows)

## Files Created/Modified

- `src/indexer/pipeline.ts` - Fully rewritten: streaming two-pass architecture, MemoryMonitor, p-queue, checkpoint resume, progressEmitter
- `src/indexer/__tests__/pipeline.test.ts` - New: 6 behavioral tests for checkpoint skip, GC ordering, fresh-vs-resume, queue drain, backpressure
- `src/http/routes/index.ts` - Added `?resume=true` query param, `IndexProgressEmitter` created per request with console logging
- `src/indexer/graph-writer.ts` - Removed deprecated `writeGraph` bulk function and `FalkorDBAdapter` import
- `src/indexer/embedder.ts` - Removed deprecated `embedAndStore` bulk function and `pLimit` import
- `src/indexer/__tests__/graph-writer.test.ts` - Removed `writeGraph` backward-compat test suite
- `src/indexer/__tests__/embedder.test.ts` - Removed `embedAndStore` backward-compat test suite

## Decisions Made

- Pass 2 call-site resolution uses a single UNWIND FalkorDB query per file (batches all call site names for one file into one round-trip), not per-call-site queries. This avoids O(call_sites) FalkorDB queries per file.
- `resume=false` (default) preserves identical behavior to the old pipeline — fresh runs always clear graph and checkpoint before processing begins.
- Source text variable is nulled after `extractChunks` within each per-file loop iteration. This allows GC to reclaim memory before the next file is read, eliminating the old `sourceTexts Map`.
- `IndexProgressEmitter` is an optional constructor parameter so routes can inject a fresh one per request. This avoids cross-request event leakage.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Vitest mock lifecycle incompatibility: `mockResolvedValue` bleeds across tests when `vi.clearAllMocks()` used**
- **Found during:** Task 1 (writing pipeline tests)
- **Issue:** `vi.clearAllMocks()` in `beforeEach` clears call history but NOT `mockResolvedValue` or `mockImplementation` overrides set per-test. Tests contaminated each other (test 1 set `readCheckpoint` to return `Set(['a.ts'])`, test 2 expected empty Set but got the leaked value).
- **Fix:** Switched to `vi.resetAllMocks()` + explicit restoration of all default implementations in `beforeEach`. Module-level mocks use `mockImplementation` (survives reset in factory, not per-test state) for registries that must not be tracked.
- **Files modified:** `src/indexer/__tests__/pipeline.test.ts`
- **Verification:** All 6 pipeline tests pass independently and in sequence.
- **Committed in:** `20964b5` (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 - Bug in test mock lifecycle)
**Impact on plan:** Test infrastructure bug only. Production pipeline code matches plan spec exactly. No scope creep.

## Issues Encountered

- MemoryMonitor and PQueue module mocks required class syntax (not arrow function factories) to work as constructors in vitest. Arrow function mocks like `vi.fn().mockImplementation(() => ({ ... }))` are not constructable — using `class Mock { ... }` syntax inside the `vi.mock()` factory fixed this.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Phase 7 complete: all OOM fixes are in place (streaming walker, checkpoint, memory monitor, progress emitter, per-file graph writer, per-chunk embedder, streaming pipeline)
- The indexer can now handle repositories of arbitrary size without accumulating allSymbols[], allTrees[], or sourceTexts in memory
- Route handlers expose `?resume=true` for crash recovery on long-running index jobs
- Progress events are logged to console and ready for Phase 6 dashboard SSE integration

---
*Phase: 07-fix-oom-memory-problem-when-indexing-very-large-repos*
*Completed: 2026-03-10*

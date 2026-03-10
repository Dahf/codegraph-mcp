---
phase: 07-fix-oom-memory-problem-when-indexing-very-large-repos
plan: "03"
subsystem: indexer
tags: [falkordb, lancedb, ollama, embeddings, graph, tdd, streaming]

# Dependency graph
requires:
  - phase: 07-01
    provides: walkRepo async generator and config schema for streaming pipeline
  - phase: 07-02
    provides: checkpoint, memory monitor, and progress emitter infrastructure

provides:
  - clearGraph() standalone function for graph clearing before streaming run
  - createGraphIndexes() standalone idempotent index creation
  - writeFileSymbols() per-file symbol write for Pass 1 of streaming pipeline
  - writeCallEdges() separated call-edge write for Pass 2 of streaming pipeline
  - embedSingleChunk() single-chunk embedder returning row-or-null (never throws)
  - storeEmbeddingRows() LanceDB table management separated from embedding

affects:
  - 07-04-streaming-pipeline (direct consumers of all new functions)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Per-file decomposition: bulk graph-write refactored into clearGraph + createGraphIndexes + writeFileSymbols + writeCallEdges"
    - "Null-return error handling: embedSingleChunk returns null on failure (never throws) for safe queue task use"
    - "Backward-compat delegation: deprecated bulk functions delegate to new granular functions, keeping existing callers working"
    - "Graph type passed directly: new functions accept Graph directly (not FalkorDBAdapter) for simpler call sites"

key-files:
  created:
    - src/indexer/__tests__/graph-writer.test.ts
    - src/indexer/__tests__/embedder.test.ts
  modified:
    - src/indexer/graph-writer.ts
    - src/indexer/embedder.ts

key-decisions:
  - "New graph functions accept Graph directly (not FalkorDBAdapter) — cleaner call site in streaming pipeline, avoids selectGraph() at each call"
  - "writeGraph() delegates to clearGraph()+createGraphIndexes()+writeFileSymbols()+writeCallEdges() for DRY backward compat"
  - "embedAndStore() delegates to embedSingleChunk()+storeEmbeddingRows() — same behavior, zero code duplication"
  - "embedSingleChunk returns null on error (not throws) — required for safe p-queue task use without aborting the queue"

patterns-established:
  - "Per-file graph write: writeFileSymbols() receives Graph + repoId + SourceFile + ExtractedSymbols"
  - "Pass-separated call edges: writeCallEdges() is intentionally separate from writeFileSymbols() for two-pass pipeline"
  - "Row-or-null embedding: embedSingleChunk always returns Record<string, unknown> | null — callers filter nulls"

requirements-completed: []

# Metrics
duration: 5min
completed: 2026-03-10
---

# Phase 07 Plan 03: Graph-Writer Per-File Methods and Embedder Queue Adaptation Summary

**Per-file FalkorDB write functions (writeFileSymbols, writeCallEdges, clearGraph, createGraphIndexes) and null-return single-chunk embedder (embedSingleChunk, storeEmbeddingRows) extracted for streaming pipeline use**

## Performance

- **Duration:** ~5 min
- **Started:** 2026-03-10T09:51:28Z
- **Completed:** 2026-03-10T09:55:00Z
- **Tasks:** 2 (TDD: RED + GREEN each)
- **Files modified:** 4

## Accomplishments

- Extracted 4 standalone graph functions from the bulk writeGraph() with identical Cypher queries
- Added embedSingleChunk() returning null-or-row for safe use as a p-queue task
- Added storeEmbeddingRows() separating LanceDB table management from embedding logic
- Both writeGraph() and embedAndStore() now delegate to new functions — zero behavior change, fully backward compatible
- 30 tests covering all new functions, edge cases, and backward compat

## Task Commits

Each task was committed atomically (TDD: failing test commit included in same feat commit):

1. **Task 1: Per-file graph write and per-edge call-graph write functions** - `97076ff` (feat)
2. **Task 2: Single-chunk embedding function for queue consumer** - `364644c` (feat)

## Files Created/Modified

- `src/indexer/graph-writer.ts` — Added clearGraph(), createGraphIndexes(), writeFileSymbols(), writeCallEdges(); writeGraph() deprecated and delegates to new functions
- `src/indexer/embedder.ts` — Added embedSingleChunk(), storeEmbeddingRows(); embedAndStore() deprecated and delegates to new functions
- `src/indexer/__tests__/graph-writer.test.ts` — 21 tests for all new graph functions + backward compat
- `src/indexer/__tests__/embedder.test.ts` — 9 tests for embedSingleChunk, storeEmbeddingRows, embedAndStore backward compat

## Decisions Made

- New graph functions accept `Graph` directly (not `FalkorDBAdapter`) — cleaner call site in streaming pipeline, selectGraph() stays in the pipeline
- writeGraph() delegates to the new decomposed functions for DRY behavior — no query duplication
- embedSingleChunk() returns null on any error (never throws) — required for safe p-queue task semantics
- embedAndStore() delegates to embedSingleChunk()+storeEmbeddingRows() — exact same behavior, zero code duplication

## Deviations from Plan

None — plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- writeFileSymbols() and writeCallEdges() ready for Pass 1 / Pass 2 streaming pipeline (Plan 07-04)
- embedSingleChunk() ready for p-queue task wrapping in streaming pipeline
- storeEmbeddingRows() ready for periodic flush in streaming pipeline
- All existing tests still pass (backward compat verified)

---
*Phase: 07-fix-oom-memory-problem-when-indexing-very-large-repos*
*Completed: 2026-03-10*

## Self-Check: PASSED

All files and commits verified:
- FOUND: src/indexer/graph-writer.ts
- FOUND: src/indexer/embedder.ts
- FOUND: src/indexer/__tests__/graph-writer.test.ts
- FOUND: src/indexer/__tests__/embedder.test.ts
- FOUND: .planning/phases/07-fix-oom.../07-03-SUMMARY.md
- FOUND: commit 97076ff (Task 1)
- FOUND: commit 364644c (Task 2)

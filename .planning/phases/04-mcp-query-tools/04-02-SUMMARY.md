---
phase: 04-mcp-query-tools
plan: "02"
subsystem: query
tags: [graph, falkordb, lancedb, symbol-lookup, call-graph]
dependency_graph:
  requires: [04-01]
  provides: [graph-query-layer]
  affects: [04-03, 04-04]
tech_stack:
  added: []
  patterns: [exact-then-prefix-lookup, null-guarded-graph-query, scalar-lancedb-scan]
key_files:
  created:
    - src/query/graph.ts
  modified:
    - src/types/index.ts
decisions:
  - "Three separate graph.query() calls per node label instead of UNION — FalkorDB UNION across node types not guaranteed; separate queries merged client-side"
  - "Promise.allSettled for per-label queries within a repo — one label missing does not fail others"
  - "escapeSql() helper doubles single quotes in LanceDB WHERE values — prevents SQL injection in scalar scan"
metrics:
  duration: "2 min"
  completed: "2026-03-09"
  tasks_completed: 2
  files_modified: 2
---

# Phase 4 Plan 2: Graph Query Layer Summary

**One-liner:** Exact-then-prefix symbol lookup across FalkorDB per-repo graphs with CALLS-edge expansion and scalar LanceDB sourceText retrieval.

## What Was Built

Added `SymbolResult` to the type library and implemented `src/query/graph.ts` with three exported pure functions:

- **`fetchSourceText`** — scalar LanceDB scan (no vector embedding) that retrieves `sourceText` by `symbolName + filePath + repoId`; returns `''` on any error.
- **`getCallNeighbors`** — traverses `CALLS` edges in a repo's FalkorDB graph to return direct `callers` and `callees` for a named `Function` node.
- **`lookupSymbol`** — orchestrates exact-then-prefix lookup across all configured repos (or a single repo when `repoId` is supplied); calls `getCallNeighbors` and `fetchSourceText` for each hit; returns `SymbolResult[]`.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add SymbolResult type | b2c1285 | src/types/index.ts |
| 2 | Implement graph.ts | b57b8bc | src/query/graph.ts |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical Functionality] Promise.allSettled for per-label graph queries**
- **Found during:** Task 2
- **Issue:** Plan noted FalkorDB may not support UNION cleanly and suggested three separate queries. Using Promise.all would cause the whole repo to fail if any single label query errored.
- **Fix:** Used Promise.allSettled so that a missing label (e.g., no Type nodes in a graph) silently returns 0 hits without throwing.
- **Files modified:** src/query/graph.ts

**2. [Rule 2 - Missing Critical Functionality] SQL escaping helper for LanceDB WHERE values**
- **Found during:** Task 2
- **Issue:** Plan did not mention escaping, but single quotes in symbol names or file paths would break the WHERE string.
- **Fix:** Added `escapeSql()` helper that doubles single quotes before interpolating into WHERE predicates.
- **Files modified:** src/query/graph.ts

## Self-Check: PASSED

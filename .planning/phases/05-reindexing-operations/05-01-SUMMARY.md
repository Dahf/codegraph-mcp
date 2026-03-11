---
phase: 05-reindexing-operations
plan: "01"
subsystem: indexer
tags: [incremental-indexing, git-diff, checkpoint, graph-writer, pipeline]
dependency_graph:
  requires: []
  provides:
    - pullRepo() in cloner.ts
    - readLastCommit/writeLastCommit in checkpoint.ts
    - clearFileNodes in graph-writer.ts
    - parseDiffNameStatus in pipeline.ts
    - IndexPipeline.run({ incremental: true })
  affects:
    - src/indexer/pipeline.ts
    - src/indexer/checkpoint.ts
    - src/indexer/cloner.ts
    - src/indexer/graph-writer.ts
    - src/indexer/progress.ts
tech_stack:
  added: []
  patterns:
    - git diff --name-status for change detection
    - MERGE upsert for lastCommit SHA persistence in FalkorDB
    - Two-query clearFileNodes (filePath + path schema inconsistency)
    - Clone preservation (no rm in finally) for incremental pulls
key_files:
  created:
    - src/indexer/__tests__/incremental.test.ts
    - src/indexer/__tests__/incremental-pipeline.test.ts
  modified:
    - src/indexer/cloner.ts
    - src/indexer/checkpoint.ts
    - src/indexer/graph-writer.ts
    - src/indexer/progress.ts
    - src/indexer/pipeline.ts
    - src/indexer/__tests__/checkpoint.test.ts
    - src/indexer/__tests__/pipeline-e2e.test.ts
decisions:
  - clearCheckpoint uses SET c.processedFiles = null instead of DELETE — preserves lastCommit SHA across full re-index cleanup
  - parseDiffNameStatus exported from pipeline.ts for testability
  - Two-file test split (incremental.test.ts + incremental-pipeline.test.ts) required because Vitest hoists vi.mock() calls — mixing real imports and module mocks in one file causes real implementations to be replaced by mocks
  - Clone directory preserved after both full and incremental runs — required for future incremental git pull
  - escapeSql inlined in pipeline.ts (not imported from query layer) to avoid circular imports
metrics:
  duration: 9 min
  completed: 2026-03-11
  tasks: 2
  files_modified: 7
  files_created: 2
---

# Phase 5 Plan 1: Incremental Indexing Engine Summary

Incremental indexing engine with full-clone git diff, per-file graph/vector deletion, and HEAD SHA checkpoint — enabling re-index of only changed files since the last run.

## Tasks Completed

| Task | Description | Commit |
|------|-------------|--------|
| 1 | Cloner, checkpoint, and graph-writer extensions | 4ca3aed |
| 2 | Incremental mode in IndexPipeline.run() | 7f5cada |

## What Was Built

**cloner.ts**: Removed `--depth 1` (full clone required for git diff history). Added `pullRepo(destPath)` — calls `simpleGit(destPath).pull()` on an existing clone.

**checkpoint.ts**: Added `readLastCommit(graph, repoId)` and `writeLastCommit(graph, repoId, sha)` — persist the indexed HEAD commit SHA in the Checkpoint node via MERGE upsert. Changed `clearCheckpoint` from `DELETE c` to `SET c.processedFiles = null` so the Checkpoint node (and its `lastCommit` property) survives fresh re-index runs.

**graph-writer.ts**: Added `clearFileNodes(graph, repoId, filePath)` — two-query deletion handling the FalkorDB schema inconsistency: symbol nodes use `filePath` property, File nodes use `path` property.

**progress.ts**: Added `incremental:started` event to `IndexProgressEvents` with `changedFiles` and `deletedFiles` counts.

**pipeline.ts**:
- Exported `parseDiffNameStatus(raw)` — parses `git diff --name-status` output into `ChangedFile[]` (handles A/M/D/R status codes, ignores C and others).
- Exported `ChangedFile` interface.
- `IndexPipeline.run()` now accepts `{ incremental?: boolean }` option.
- Incremental branch in `runIncremental()`: pulls existing clone, reads `lastCommit`, calls `git diff --name-status`, processes only the delta (clearFileNodes + LanceDB deleteRows + re-parse for changed/added; delete-only for deleted; delete-old + add-new for renamed).
- Full index path now writes `lastCommit` SHA at Stage 6 to bootstrap the first incremental run.
- Clone directory preserved after both full and incremental runs (empty `finally {}` block — no `rm`).

## Test Coverage

- **incremental.test.ts** (19 tests): pullRepo, readLastCommit, writeLastCommit, clearCheckpoint behavior, clearFileNodes, parseDiffNameStatus — all using real implementations.
- **incremental-pipeline.test.ts** (3 tests): IndexPipeline incremental mode with mocked adapters — pullRepo vs cloneRepo, fallback on no lastCommit, early return on same HEAD.
- Updated **checkpoint.test.ts** and **pipeline-e2e.test.ts** to reflect the SET-not-DELETE clearCheckpoint change and preserved clone directory.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Split into two test files due to Vitest mock hoisting**
- **Found during:** Task 1 test execution
- **Issue:** Vitest hoists all `vi.mock()` calls to the top of the file regardless of their position. When unit tests (using real implementations) and integration tests (using full module mocks) are in the same file, the hoisted mocks replace real implementations, causing unit tests to call mock stubs instead of real functions.
- **Fix:** Split `incremental.test.ts` (real implementations, minimal mocks) from `incremental-pipeline.test.ts` (all pipeline deps mocked).
- **Files modified:** Two new test files instead of one.
- **Commits:** 4ca3aed, 7f5cada

**2. [Rule 1 - Bug] Updated checkpoint.test.ts and pipeline-e2e.test.ts for behavior change**
- **Found during:** Post-Task 1 full test suite run
- **Issue:** Existing tests asserted `clearCheckpoint` issues a `DELETE` query and that clone directory is cleaned up after full run — both behaviors intentionally changed by this plan.
- **Fix:** Updated `checkpoint.test.ts` (2 tests) to assert `SET`-not-DELETE; updated `pipeline-e2e.test.ts` (assertions 8 and 9) to check for `SET Checkpoint` queries and assert clone directory is preserved.
- **Files modified:** `checkpoint.test.ts`, `pipeline-e2e.test.ts`
- **Commits:** 4ca3aed, 7f5cada

## Self-Check: PASSED

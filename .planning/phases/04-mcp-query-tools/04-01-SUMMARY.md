---
phase: 04-mcp-query-tools
plan: 01
subsystem: query
tags: [vector-search, lancedb, embeddings, types]
dependency_graph:
  requires: [src/adapters/lancedb.ts, src/adapters/ollama.ts, src/adapters/falkordb.ts, src/indexer/embedder.ts]
  provides: [src/constants.ts, src/query/vector.ts, SearchResult type]
  affects: [src/indexer/pipeline.ts]
tech_stack:
  added: []
  patterns: [QueryDeps injection pattern for query layer, cosine distance score conversion (score = 1 - distance)]
key_files:
  created: [src/constants.ts, src/query/vector.ts]
  modified: [src/types/index.ts, src/indexer/pipeline.ts]
decisions:
  - "EMBED_MODEL shared constant eliminates string duplication between indexing and query layers"
  - "vectorSearch casts table.search() result to lancedb.VectorQuery (passing number[] always produces VectorQuery at runtime)"
  - "buildWhereClause uses SQL single-quoted string literals for LanceDB .where() predicate"
metrics:
  duration: 8 min
  completed: 2026-03-09
  tasks_completed: 3
  files_modified: 4
---

# Phase 4 Plan 1: Vector Search Foundation Summary

Shared EMBED_MODEL constant, SearchResult type, and vectorSearch() function using cosine similarity with LanceDB and score threshold filtering.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Create EMBED_MODEL constant and update pipeline import | 1bbf92d | src/constants.ts, src/indexer/pipeline.ts |
| 2 | Add SearchResult type to src/types/index.ts | 8226762 | src/types/index.ts |
| 3 | Implement vectorSearch() in src/query/vector.ts | b206176 | src/query/vector.ts |

## Artifacts Produced

- **src/constants.ts** — `export const EMBED_MODEL = 'nomic-embed-text'` — single source of truth for the embedding model name
- **src/types/index.ts** — `SearchResult` interface with all 9 fields (sourceText, filePath, symbolName, symbolType, startLine, endLine, language, repoId, score)
- **src/query/vector.ts** — `QueryDeps` interface and `vectorSearch()` function
- **src/indexer/pipeline.ts** — replaced hardcoded `'nomic-embed-text'` with `EMBED_MODEL` import

## Key Decisions

1. **EMBED_MODEL shared constant** — eliminates the risk of model mismatch between indexing and query; mismatched models produce meaningless cosine similarity scores.
2. **Type cast for VectorQuery** — `table.search()` returns `VectorQuery | Query` in the lancedb type signatures, but passing a `number[]` always produces a `VectorQuery` at runtime; cast used to access `.distanceType()`.
3. **buildWhereClause SQL literals** — LanceDB `.where()` accepts SQL strings (not parameterized queries), so filter values are single-quoted directly.
4. **Empty array on missing table** — fresh installs have no `embeddings` table; catching the openTable error and returning `[]` avoids crashing the MCP server before any repo is indexed.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed unused import diagnostic from staged addition**
- **Found during:** Task 1
- **Issue:** Import of EMBED_MODEL was added before the hardcoded string was replaced, causing a TypeScript "declared but never read" hint
- **Fix:** Replaced `'nomic-embed-text'` literal with `EMBED_MODEL` immediately
- **Files modified:** src/indexer/pipeline.ts
- **Commit:** 1bbf92d

**2. [Rule 1 - Bug] Fixed VectorQuery union type error**
- **Found during:** Task 3 (tsc check)
- **Issue:** `table.search()` returns `VectorQuery | Query`; `.distanceType()` only exists on `VectorQuery`, causing TS2339
- **Fix:** Added `import * as lancedb from '@lancedb/lancedb'` and cast search result to `lancedb.VectorQuery`
- **Files modified:** src/query/vector.ts
- **Commit:** b206176

**3. [Rule 1 - Bug] Fixed implicit any on row filter/map callbacks**
- **Found during:** Task 3 (tsc check)
- **Issue:** Arrow function parameters in `.filter()` and `.map()` had implicit `any` type under strict mode
- **Fix:** Typed row parameters as `Record<string, unknown>` with explicit field casts
- **Files modified:** src/query/vector.ts
- **Commit:** b206176

## Self-Check: PASSED

- src/constants.ts: FOUND
- src/query/vector.ts: FOUND
- commit 1bbf92d: FOUND
- commit 8226762: FOUND
- commit b206176: FOUND

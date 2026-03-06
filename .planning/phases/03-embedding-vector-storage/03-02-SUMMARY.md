---
phase: 03-embedding-vector-storage
plan: 02
subsystem: indexer
tags: [ollama, lancedb, embeddings, p-limit, concurrency, vector-storage]

requires:
  - phase: 03-embedding-vector-storage/01
    provides: "OllamaAdapter.embed(), LanceDB CRUD, chunker, IndexResult counters"
  - phase: 02-parsing-graph-storage
    provides: "IndexPipeline, symbol extractors, graph writer, route/app wiring"
provides:
  - "embedAndStore() orchestrator with concurrency-limited Ollama calls"
  - "Stage 5 embedding integration in IndexPipeline"
  - "Full adapter wiring through routes/app/entry point"
  - "End-to-end: POST /repos/:id/index generates embeddings and stores in LanceDB"
affects: [04-mcp-tools, search, query]

tech-stack:
  added: [p-limit]
  patterns: [concurrency-limited-embedding, delete-before-insert-reindex, non-fatal-stage-pattern]

key-files:
  created: [src/indexer/embedder.ts]
  modified: [src/indexer/pipeline.ts, src/http/routes/index.ts, src/http/app.ts, src/index.ts]

key-decisions:
  - "p-limit concurrency set to 5 for Ollama embedding requests"
  - "Stage 5 wrapped in independent try/catch -- embedding failure never affects graph data"
  - "Delete-before-insert pattern for LanceDB re-indexing (delete by repoId, then add)"

patterns-established:
  - "Non-fatal pipeline stage: Stage 5 catch block sets embeddingsFailed=-1 to signal total failure without aborting"
  - "Adapter pass-through: concrete adapter types threaded from entry point through createApp/routes to pipeline constructor"

requirements-completed: [PARS-07, PARS-08, STOR-02]

duration: 4min
completed: 2026-03-06
---

# Phase 3 Plan 02: Embedder Orchestrator & Pipeline Integration Summary

**embedAndStore orchestrator with p-limit concurrency, Stage 5 pipeline integration, and full adapter wiring from entry point to IndexPipeline**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-06T12:12:08Z
- **Completed:** 2026-03-06T12:15:42Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments
- Created embedAndStore() orchestrator with concurrency-limited Ollama embedding calls via p-limit
- Integrated embedding as Stage 5 in IndexPipeline, non-fatal to graph data
- Wired OllamaAdapter and LanceDBAdapter through route/app/entry layers
- Delete-before-insert pattern enables safe re-indexing of the same repo

## Task Commits

Each task was committed atomically:

1. **Task 1: Create embedder orchestrator and install p-limit** - `03a5a75` (feat)
2. **Task 2: Integrate Stage 5 into pipeline and wire adapters through app layer** - `b6f6028` (feat)

## Files Created/Modified
- `src/indexer/embedder.ts` - Embedding orchestrator: concurrency-limited Ollama calls, LanceDB storage with delete-before-insert
- `src/indexer/pipeline.ts` - Added Stage 5 after graph write, source text caching, new constructor params
- `src/http/routes/index.ts` - Updated indexRoutes to accept and pass OllamaAdapter + LanceDBAdapter
- `src/http/app.ts` - Updated createApp signature to thread new adapters to indexRoutes
- `src/index.ts` - Pass ollama and lancedb adapter instances to createApp

## Decisions Made
- p-limit concurrency of 5 for Ollama embedding requests (balances throughput vs resource usage)
- Stage 5 has independent try/catch so embedding failure sets embeddingsFailed=-1 without affecting graph write
- Delete-before-insert pattern for re-indexing: removes old embeddings by repoId before adding new ones

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Used --legacy-peer-deps for p-limit install**
- **Found during:** Task 1 (npm install p-limit)
- **Issue:** tree-sitter-cpp peer dependency conflict with tree-sitter versions prevented npm install
- **Fix:** Used `npm install p-limit --legacy-peer-deps` (pre-existing conflict, not caused by p-limit)
- **Files modified:** package.json, package-lock.json
- **Verification:** p-limit ESM import verified working
- **Committed in:** 03a5a75 (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Workaround for pre-existing peer dep conflict. No scope creep.

## Issues Encountered
None beyond the npm peer dependency conflict handled above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Embedding pipeline is end-to-end: clone -> walk -> parse -> graph-write -> embed -> vector-store
- POST /repos/:id/index response includes embeddingsStored and embeddingsFailed counts
- Phase 3 complete -- ready for Phase 4 (MCP tools / search)
- Requires Ollama running with CodeRankEmbed model pulled for embeddings to succeed at runtime

---
*Phase: 03-embedding-vector-storage*
*Completed: 2026-03-06*

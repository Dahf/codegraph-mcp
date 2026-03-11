---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: in_progress
last_updated: "2026-03-11T09:00:00.000Z"
progress:
  total_phases: 8
  completed_phases: 7
  total_plans: 19
  completed_plans: 18
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-03-02)

**Core value:** AI development tools get instant, accurate cross-codebase context — so developers never have to manually explain their project structure again.
**Current focus:** Phase 5 Re-indexing Operations — Plan 1 complete (incremental indexing engine)

## Current Position

Phase: 5 of 8 (Re-indexing Operations) -- In Progress
Plan: 1 of 2 in current phase (plan 1 complete)
Status: In Progress
Last activity: 2026-03-11 — Plan 05-01 complete (incremental indexing engine: pullRepo, readLastCommit/writeLastCommit, clearFileNodes, parseDiffNameStatus, IndexPipeline incremental mode)

Progress: [█████████░] 90%

## Performance Metrics

**Velocity:**
- Total plans completed: 8
- Average duration: 8 min
- Total execution time: ~65 min

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 01-foundation | 3 | 22 min | 7 min |
| 02-parsing-graph-storage | 4 | 44 min | 11 min |
| 03-embedding-vector-storage | 2 | 7 min | 4 min |

**Recent Trend:**
- Last 5 plans: 02-03 (4 min), 02-04 (15 min), 03-01 (3 min), 03-02 (4 min)
- Trend: stable

*Updated after each plan completion*
| Phase 03-embedding-vector-storage P01 | 3 | 2 tasks | 4 files |
| Phase 03-embedding-vector-storage P02 | 4 | 2 tasks | 5 files |
| Phase 04-mcp-query-tools P01 | 8 | 3 tasks | 4 files |
| Phase 04-mcp-query-tools P02 | 2 | 2 tasks | 2 files |
| Phase 04-mcp-query-tools P03 | 2 | 2 tasks | 4 files |
| Phase 04-mcp-query-tools P04 | 3 | 3 tasks | 3 files |
| Phase 07-fix-oom-memory-problem-when-indexing-very-large-repos P07-02 | 6 | 2 tasks | 6 files |
| Phase 07 P01 | 8 | 2 tasks | 8 files |
| Phase 07-fix-oom-memory-problem-when-indexing-very-large-repos P07-03 | 5 | 2 tasks | 4 files |
| Phase 07 P04 | 12 | 3 tasks | 6 files |

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- [Pre-phase]: Use Streamable HTTP transport — SSE deprecated and removed April 1, 2026
- [Pre-phase]: FalkorDB replaces Kuzu — Kuzu reached EOL
- [Pre-phase]: TypeScript/Node.js stack — best MCP SDK support and native TreeSitter bindings
- [Pre-phase]: LanceDB for vectors — embedded, disk-based, no server process needed
- [Pre-phase]: CodeRankEmbed via Ollama — 521MB local model, no external API dependency
- [01-01]: @modelcontextprotocol/sdk is still monolithic (v1.27.1) — split packages from research do NOT exist on npm; use sub-path imports
- [01-01]: Transport class is StreamableHTTPServerTransport (not NodeStreamableHTTPServerTransport as research stated)
- [01-01]: Session cleanup: 30-min interval + 1-hour TTL prevents session leaks
- [Phase 01-foundation]: falkordb uses createClient() not FalkorDB class — package re-exports @falkordb/client (Redis-based); ping() is the validation method
- [Phase 01-foundation]: Adapter interface uses base Adapter type (not concrete classes) in Adapters grouping — prevents circular module imports in types/index.ts
- [Phase 01-foundation]: LanceDB health validation uses tableNames() not isOpen() alone — real disk read guarantees actual accessibility
- [01-03]: healthRoutes accepts RepoStore (not Config) for live repo count — config snapshot would miss runtime-added repos
- [01-03]: Promise.allSettled used for health checks — all three adapters checked in parallel, one failure doesn't block others
- [01-03]: configPath in index.ts uses same argv[2]/cwd logic as loadConfig() — ensures persistConfig() targets same file
- [02-01]: Grammar versions 0.25.0 (js, py, go) are ABI-incompatible with tree-sitter@0.22.4 at runtime — downgraded to 0.23.x series
- [02-01]: Grammar modules declare 'language: unknown' for version-agnosticism; bridge via 'as unknown as Parser.Language'; LanguageConfig.grammar typed as 'object'
- [02-01]: FalkorDB client does not expose selectGraph() — use @falkordb/graph Graph class directly: new Graph(client, graphName)
- [Phase 02-02]: hasError is a property on SyntaxNode not a method (tree-sitter@0.22.4) — use fn.hasError not fn.hasError()
- [Phase 02-02]: JavaScript grammar uses identifier for class names not type_identifier — separate JS_CLASS_QUERY required vs TypeScript/TSX grammars
- [Phase 02-02]: extractTsx is a separate export (TSX grammar queries compiled separately from TS queries) — registry .tsx entry uses extractTsx
- [Phase 02-parsing-graph-storage]: Rust impl method extraction uses tree traversal not Query — reliably pairs impl type name with function_item children without complex S-expression nesting
- [Phase 02-parsing-graph-storage]: C++ declarator chain uses recursive resolver — handles pointer_declarator, qualified_identifier, destructor_name, operator_name at arbitrary nesting depth
- [Phase 02-parsing-graph-storage]: Go receiver type resolution walks parameter_list → parameter_declaration → type child, unwrapping pointer_type for pointer receivers (*MyType)
- [Phase 02-parsing-graph-storage]: callSites added as required field to ExtractedSymbols; generic tree-walk in pipeline.ts for cross-language call_expression extraction
- [Phase 02-parsing-graph-storage]: falkorAdapter passed as explicit 6th parameter to createApp() — concrete FalkorDBAdapter type needed for selectGraph(), avoids unsafe cast from base Adapter interface
- [Phase 02-parsing-graph-storage]: indexRoutes mounted before repoRoutes to prevent Express capturing 'index-all' as :id parameter
- [03-01]: LanceDB createTable uses mode 'overwrite' (not existOk) for idempotent table creation
- [03-01]: findLeadingCommentStart stops at double blank lines to avoid capturing unrelated comments
- [03-02]: p-limit concurrency of 5 for Ollama embedding requests -- balances throughput vs resource usage
- [03-02]: Stage 5 has independent try/catch so embedding failure never affects graph data (embeddingsFailed=-1 signals total failure)
- [03-02]: Delete-before-insert pattern for LanceDB re-indexing -- removes old embeddings by repoId before adding new
- [Phase 04-mcp-query-tools]: EMBED_MODEL shared constant eliminates string duplication between indexing and query layers
- [Phase 04-mcp-query-tools]: vectorSearch casts table.search() result to lancedb.VectorQuery for distanceType access
- [04-02]: Three separate graph.query() calls per node label instead of UNION — FalkorDB UNION across node types not guaranteed; merged client-side
- [04-02]: Promise.allSettled for per-label queries — one label missing does not fail others
- [04-02]: escapeSql() helper doubles single quotes in LanceDB WHERE values to prevent SQL injection in scalar scan
- [04-03]: search_code wraps vectorSearch result in { results, repoId, count } envelope for client context
- [04-03]: lookup_symbol distinguishes "not configured" vs "not indexed" empty results with separate descriptive messages
- [04-03]: createMcpServer(deps: QueryDeps) — adapters passed through from app.ts closure, no lifecycle management inside server factory
- [Phase 04-mcp-query-tools]: Token budget uses 4-chars-per-token heuristic, default 4000 tokens (~16000 chars), caller-overridable via max_tokens
- [Phase 04-mcp-query-tools]: Related chunks use startLine=0/endLine=0 sentinel when line info unavailable from graph — avoids fabricating line numbers
- [Phase 07-02]: FalkorDB MERGE pattern for checkpoint upsert -- safe repeated writes without duplicates
- [Phase 07-02]: MemoryMonitor timer.unref() prevents process/test-runner hang (Pitfall 5)
- [Phase 07-02]: IndexProgressEmitter uses typed EventEmitter subclass -- zero deps, full type safety at call sites
- [Phase 07]: Zod v4 requires explicit full default object for nested objects -- .default({}) stores literal empty object, not schema-computed defaults
- [Phase 07]: walkRepo uses opendir() for pull-based directory iteration instead of readdir() -- avoids loading full directory listing into memory
- [Phase 07-03]: New graph functions accept Graph directly (not FalkorDBAdapter) — cleaner call site in streaming pipeline
- [Phase 07-03]: embedSingleChunk returns null on error (never throws) — required for safe p-queue task semantics
- [Phase 07-04]: Pass 2 call-site resolution uses single UNWIND query per file (one FalkorDB round-trip per file, not per call site)
- [Phase 07-04]: Source text nulled after extractChunks — GC can reclaim before next file is loaded
- [Phase 07-04]: IndexProgressEmitter is optional constructor param — fresh emitter per request prevents cross-request event leakage
- [05-01]: clearCheckpoint uses SET c.processedFiles = null instead of DELETE — preserves lastCommit SHA across full re-index cleanup so incremental baseline survives
- [05-01]: parseDiffNameStatus exported from pipeline.ts for testability (pure function, no deps)
- [05-01]: Two-file test split (incremental.test.ts + incremental-pipeline.test.ts) required — Vitest hoists vi.mock() calls so mixing real imports and module mocks in one file replaces real implementations
- [05-01]: Clone directory preserved after both full and incremental runs — required for future incremental git pull without re-cloning

### Roadmap Evolution

- Phase 7 added: Fix OOM memory problem when indexing very large repos

### Pending Todos

None yet.

### Blockers/Concerns

- FalkorDB vs FalkorDBLite: Need to benchmark embedded mode performance during Phase 1
- Streamable HTTP in VS Code: Confirm VS Code MCP client fully supports Streamable HTTP (flag from research)
- tree-sitter C++ grammar: Known edge cases with templates and macros — accept partial coverage

## Session Continuity

Last session: 2026-03-11
Stopped at: Completed 05-reindexing-operations/05-01-PLAN.md (incremental indexing engine: pullRepo, readLastCommit/writeLastCommit, clearFileNodes, parseDiffNameStatus, IndexPipeline incremental mode)
Resume file: None

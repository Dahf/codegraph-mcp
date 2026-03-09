---
phase: 04-mcp-query-tools
plan: "04"
subsystem: mcp-tools
tags: [mcp, context-bundle, vector-search, call-graph, token-budget]
dependency_graph:
  requires: [04-01, 04-02, 04-03]
  provides: [get_context_bundle-tool, ContextBundle-type]
  affects: [src/server.ts, src/types/index.ts]
tech_stack:
  added: []
  patterns: [token-budget-heuristic, p-limit-concurrency, set-deduplication, vector-graph-fusion]
key_files:
  created:
    - src/tools/contextBundle.ts
  modified:
    - src/types/index.ts
    - src/server.ts
decisions:
  - "Token budget uses 4-chars-per-token heuristic, default 4000 tokens (~16000 chars), caller-overridable via max_tokens"
  - "p-limit concurrency of 5 for parallel call-graph neighbor fetches — mirrors embedding pipeline pattern"
  - "Related chunks use startLine=0/endLine=0 sentinel when line info unavailable from graph — avoids fabricating line numbers"
  - "Empty sourceText from fetchSourceText skipped silently — covers builtins and symbols not yet indexed in LanceDB"
metrics:
  duration: 3 min
  completed: "2026-03-09"
  tasks: 3
  files: 3
---

# Phase 4 Plan 4: Context Bundle Tool Summary

**One-liner:** Token-budgeted context bundle combining vector search seeds with call-graph neighbor expansion, formatted as Markdown Relevant/Related Code sections.

## What Was Built

The `get_context_bundle` MCP tool (MCPS-04) assembles a pre-built context package for AI clients by:
1. Running vector search (k=20) to find the most semantically relevant code chunks
2. Expanding each seed's call-graph neighbors via FalkorDB (callers and callees)
3. Filling a token budget (default 4000 tokens / ~16000 chars) most-relevant-first
4. Deduplicating chunks via a `Set` keyed on `repoId:filePath:symbolName`
5. Formatting output as `## Relevant Code` and `## Related Code` Markdown sections

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add ContextBundle type to src/types/index.ts | 293598c | src/types/index.ts |
| 2 | Implement get_context_bundle tool handler | a896d4b | src/tools/contextBundle.ts |
| 3 | Register get_context_bundle in createMcpServer() | 05e5c2a | src/server.ts |

## Key Implementation Details

**Token budget (src/tools/contextBundle.ts):**
- `CHARS_PER_TOKEN = 4` — character-based heuristic, no tokenizer dependency
- Default `maxTokens = 4000` → budget of 16000 characters
- Caller can override via `max_tokens` parameter
- Seeds fill budget first (highest score), related chunks fill remainder

**Deduplication:**
- `seen = new Set<string>()` keyed on `${repoId}:${filePath}:${symbolName}`
- Prevents duplicate chunks whether they appear as seed or neighbor

**Call-graph expansion:**
- `pLimit(5)` limits concurrent `getCallNeighbors()` + `fetchSourceText()` calls
- Empty `sourceText` from `fetchSourceText()` signals symbol not in LanceDB — skipped silently
- `relationNote` set to `'caller of {symbolName}'` or `'callee of {symbolName}'`

**Phase 4 completion:**
- All three MCP tools registered in `createMcpServer()`: `search_code`, `lookup_symbol`, `get_context_bundle`
- Full project compiles with zero TypeScript errors

## Deviations from Plan

None - plan executed exactly as written.

## Self-Check: PASSED

- src/tools/contextBundle.ts: FOUND
- src/types/index.ts: FOUND
- src/server.ts: FOUND
- Commit 293598c (ContextBundle types): FOUND
- Commit a896d4b (contextBundle.ts): FOUND
- Commit 05e5c2a (server.ts registration): FOUND

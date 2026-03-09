---
phase: 04-mcp-query-tools
plan: 03
subsystem: mcp-tools
tags: [mcp, tools, search, symbol-lookup, wiring]
dependency_graph:
  requires:
    - 04-01  # vectorSearch, QueryDeps
    - 04-02  # lookupSymbol, SymbolResult
  provides:
    - search_code MCP tool
    - lookup_symbol MCP tool
    - createMcpServer(deps: QueryDeps)
  affects:
    - src/server.ts
    - src/http/app.ts
tech_stack:
  added: []
  patterns:
    - MCP tool registration via server.registerTool() with Zod inputSchema
    - Thin tool handler wrappers delegating to query layer functions
    - try/catch with text error content per MCP SDK contract
key_files:
  created:
    - src/tools/searchCode.ts
    - src/tools/lookupSymbol.ts
  modified:
    - src/server.ts
    - src/http/app.ts
decisions:
  - search_code wraps response in { results, repoId, count } envelope for client context
  - lookup_symbol surfaces two distinct messages for unconfigured vs unindexed repos
  - createMcpServer() signature changed to accept QueryDeps — adapters already connected in app.ts closure
metrics:
  duration: 2 min
  completed: 2026-03-09
  tasks_completed: 2
  files_created: 2
  files_modified: 2
---

# Phase 4 Plan 3: MCP Tool Handlers and Server Wiring Summary

**One-liner:** search_code and lookup_symbol MCP tools wired into createMcpServer(QueryDeps) as thin Zod-validated handlers over vectorSearch and lookupSymbol.

## What Was Built

Both MCP query tools are now live on every session. The tool layer is a thin wrapper over the query layer implemented in plans 04-01 and 04-02.

**src/tools/searchCode.ts** — Registers `search_code` with a Zod schema covering all vectorSearch options: `query`, `k`, `minScore`, `language`, `symbolType`, `repoId`. Returns `{ results, repoId, count }` envelope so clients have context even on empty results.

**src/tools/lookupSymbol.ts** — Registers `lookup_symbol` with `name` and optional `repoId`. When `repoId` is specified and results are empty, checks `deps.config.repos` to distinguish "repo not configured" from "repo not indexed yet" and returns a descriptive message for each case.

**src/server.ts** — `createMcpServer()` signature updated to `createMcpServer(deps: QueryDeps)`. Calls `registerSearchCode(server, deps)` and `registerLookupSymbol(server, deps)` after creating the server instance. Removed the placeholder comment about future phases.

**src/http/app.ts** — Updated the `createMcpServer()` call site (line 99) to pass `{ lanceAdapter, falkorAdapter, ollamaAdapter, config }` — all four variables were already in scope as `createApp()` parameters.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Implement search_code and lookup_symbol tool handlers | 7202b0d | src/tools/searchCode.ts, src/tools/lookupSymbol.ts |
| 2 | Update createMcpServer() signature and wire in app.ts | de79e11 | src/server.ts, src/http/app.ts |

## Decisions Made

- **Response envelope for search_code:** Tool wraps `vectorSearch` result in `{ results, repoId, count }` rather than returning the bare array. This gives MCP clients the repoId filter context even when results is empty.
- **Two-path empty result messaging in lookup_symbol:** Empty results with a specified repoId trigger a config check. "Not configured" and "not indexed" are surfaced as distinct messages to guide the user.
- **createMcpServer deps parameter:** Adapters are already connected in the `createApp()` closure — passing them through the `QueryDeps` interface is zero overhead and keeps the server factory free of lifecycle concerns.

## Verification

```
npx tsc --noEmit  → zero errors
grep registerTool src/tools/searchCode.ts src/tools/lookupSymbol.ts src/server.ts → all three files match
grep createMcpServer src/http/app.ts → single call site with all four deps
```

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check

Checking created/modified files and commits...

## Self-Check: PASSED

- FOUND: src/tools/searchCode.ts
- FOUND: src/tools/lookupSymbol.ts
- FOUND: src/server.ts (modified)
- FOUND: src/http/app.ts (modified)
- FOUND commit: 7202b0d (task 1)
- FOUND commit: de79e11 (task 2)

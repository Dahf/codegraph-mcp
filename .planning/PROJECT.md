# CodeGraph MCP — Semantic Code Knowledge Base

## What This Is

A Streamable HTTP MCP Server that acts as an intelligent knowledge base for AI-powered development. It analyzes multiple codebases using TreeSitter, extracts semantic structure (call-graphs, symbol relationships, cross-file connections), and stores this in a hybrid Graph (FalkorDB) + Vector (LanceDB) database. AI tools like Claude Code and VS Code extensions query the server via MCP tools to get precise, relevant code context. Includes a web-based admin dashboard for repository management and monitoring.

## Core Value

AI development tools get instant, accurate cross-codebase context — so developers never have to manually explain their project structure again.

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] Multi-language TreeSitter parsing (TypeScript/JS, Python, Rust, Go, C++)
- [ ] Hybrid storage: Graph DB for code structure + Vector DB for semantic search
- [ ] Call-graph extraction and cross-file/cross-repo relationship mapping
- [ ] Streamable HTTP MCP Server with Semantic Search, Symbol Lookup, and Context Bundle tools
- [ ] Web admin dashboard (repo status, indexing progress, manual re-index, health stats)
- [ ] Git-hook triggered re-indexing on commits
- [ ] Variable number of repositories supported
- [ ] Local deployment (office server, VPN-accessible for team)

### Out of Scope

- Cloud/SaaS deployment — local server with VPN access is sufficient
- Impact Analysis tool ("what breaks if I change X") — valuable but deferred to v2
- Real-time file watching — Git-hook re-indexing covers the freshness requirement
- IDE-specific UI components — the MCP protocol handles the integration layer

## Context

The team works with large, multi-language projects spanning multiple repositories (microservices, frontends, shared libraries). Current AI tools (Claude Code, Copilot) hit context window limits and can't see across repo boundaries. Every new conversation requires re-explaining architecture, patterns, and conventions.

TreeSitter provides fast, accurate multi-language parsing without requiring full compilation. The MCP (Model Context Protocol) standard enables any compatible AI client to query the knowledge base via standardized tools over Streamable HTTP transport.

Research confirmed TypeScript/Node.js as the best choice: official MCP SDK is most mature, native tree-sitter bindings are significantly faster than Python's WASM approach, and the full stack (FalkorDB, LanceDB, Ollama) has Node.js clients.

## Constraints

- **Transport**: Streamable HTTP — current MCP standard (SSE deprecated, removed April 2026)
- **Parsing**: TreeSitter — must support incremental parsing for performance at scale
- **Deployment**: Single local server, no container orchestration required
- **Languages**: Must support TypeScript/JS, Python, Rust, Go, C++ from day one
- **Team access**: VPN-accessible from office network

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Hybrid Graph + Vector storage | Graph captures structural relationships (call-graphs, imports), vectors enable natural language semantic search | — Pending |
| Git-hook triggered indexing | Balances freshness with performance — no overhead from file watchers, updates on meaningful changes | — Pending |
| Streamable HTTP transport | SSE deprecated April 2026. Streamable HTTP is current MCP standard | — Pending |
| TypeScript for implementation | Best MCP SDK (official TS SDK most mature), native tree-sitter bindings (faster than WASM), strong typing | — Pending |
| FalkorDB for graph storage | In-memory Cypher queries, FalkorDBLite embedded option. Kuzu reached EOL | — Pending |
| LanceDB for vector storage | Embedded, disk-based, Rust core. No server process needed. Ranked #4 vector DB 2026 | — Pending |
| CodeRankEmbed for embeddings | 521MB local model, good quality on CodeSearchNet. Runs via Ollama | — Pending |
| Web admin dashboard (v1) | Repo management and monitoring. Search/graph UI deferred to v2 | — Pending |

---
*Last updated: 2026-03-02 after research and requirements*

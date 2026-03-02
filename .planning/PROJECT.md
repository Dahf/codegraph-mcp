# CodeGraph MCP — Semantic Code Knowledge Base

## What This Is

An SSE MCP Server that acts as an intelligent knowledge base for AI-powered development. It analyzes multiple codebases using TreeSitter, extracts semantic structure (call-graphs, symbol relationships, cross-repo connections), and stores this in a hybrid Graph + Vector database. AI tools like Claude Code and VS Code extensions query the server via MCP tools to get precise, relevant code context — eliminating the need to repeatedly explain project structure and enabling deep cross-repo understanding.

## Core Value

AI development tools get instant, accurate cross-codebase context — so developers never have to manually explain their project structure again.

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] Multi-language TreeSitter parsing (TypeScript/JS, Python, Rust, Go, C++)
- [ ] Hybrid storage: Graph DB for code structure + Vector DB for semantic search
- [ ] Call-graph extraction and cross-file/cross-repo relationship mapping
- [ ] SSE MCP Server with Semantic Search, Symbol Lookup, and Context Bundle tools
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

TreeSitter provides fast, accurate multi-language parsing without requiring full compilation. The MCP (Model Context Protocol) standard enables any compatible AI client to query the knowledge base via standardized tools over SSE transport.

The server implementation language (TypeScript or Python) will be decided during research — both have strong TreeSitter bindings and MCP SDK support.

## Constraints

- **Transport**: SSE (Server-Sent Events) — required for MCP server compatibility with VS Code
- **Parsing**: TreeSitter — must support incremental parsing for performance at scale
- **Deployment**: Single local server, no container orchestration required
- **Languages**: Must support TypeScript/JS, Python, Rust, Go, C++ from day one
- **Team access**: VPN-accessible from office network

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Hybrid Graph + Vector storage | Graph captures structural relationships (call-graphs, imports), vectors enable natural language semantic search | — Pending |
| Git-hook triggered indexing | Balances freshness with performance — no overhead from file watchers, updates on meaningful changes | — Pending |
| SSE transport for MCP | Standard MCP transport, works with Claude Code and VS Code MCP clients | — Pending |
| TypeScript vs Python for implementation | Both viable — will decide based on ecosystem research (MCP SDK maturity, TreeSitter bindings, embedding libraries) | — Pending |

---
*Last updated: 2026-03-02 after initialization*

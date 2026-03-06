# Requirements: CodeGraph MCP

**Defined:** 2026-03-02
**Core Value:** AI development tools get instant, accurate cross-codebase context — so developers never have to manually explain their project structure again.

## v1 Requirements

Requirements for initial release. Each maps to roadmap phases.

### Parsing & Indexing

- [x] **PARS-01**: System can parse TypeScript/JavaScript files via TreeSitter
- [x] **PARS-02**: System can parse Python files via TreeSitter
- [x] **PARS-03**: System can parse Rust files via TreeSitter
- [x] **PARS-04**: System can parse Go files via TreeSitter
- [x] **PARS-05**: System can parse C++ files via TreeSitter
- [x] **PARS-06**: System extracts functions, classes, types, and imports from each language
- [x] **PARS-07**: System chunks code at function/class boundaries for embedding
- [ ] **PARS-08**: System generates embeddings locally via Ollama (CodeRankEmbed)
- [x] **PARS-09**: System extracts call-graph relationships (function-to-function calls)
- [ ] **PARS-10**: System re-indexes only changed files on subsequent runs (incremental)

### Storage

- [x] **STOR-01**: Code structure stored in FalkorDB graph (symbols + relationships)
- [x] **STOR-02**: Code embeddings stored in LanceDB vector database
- [x] **STOR-03**: Graph schema covers: Files, Functions, Classes, Types, Imports, Calls edges

### MCP Server & Tools

- [x] **MCPS-01**: MCP server runs with Streamable HTTP transport
- [ ] **MCPS-02**: Semantic Search tool finds code via natural language query across all indexed repos
- [ ] **MCPS-03**: Symbol Lookup tool finds definition by name, returns source code and file location
- [ ] **MCPS-04**: Context Bundle tool auto-assembles relevant code context for a given task description

### Operations

- [x] **OPS-01**: User can add, remove, and list repositories via configuration or API
- [ ] **OPS-02**: Git-hook triggered re-indexing runs automatically on commits
- [x] **OPS-03**: Server exposes health endpoint for monitoring (uptime, indexed repos, total symbols)

### Web UI (Admin Dashboard)

- [ ] **UI-01**: Web dashboard shows list of indexed repositories with their status
- [ ] **UI-02**: Dashboard shows indexing progress and last indexed commit per repo
- [ ] **UI-03**: Dashboard allows triggering manual re-index per repository
- [ ] **UI-04**: Dashboard shows server health and statistics (total symbols, repos, embeddings count)

## v2 Requirements

Deferred to future release. Tracked but not in current roadmap.

### Web UI (Search & Visualization)

- **UI-05**: Web UI provides code search interface (like Sourcegraph-lite)
- **UI-06**: Web UI visualizes code relationships as interactive graph
- **UI-07**: Web UI allows browsing symbol definitions and navigating call-graphs

### Advanced Intelligence

- **INTL-01**: System detects cross-repo relationships (Service A calls Service B's API)
- **INTL-02**: System generates high-level codebase summary/overview from graph structure
- **INTL-03**: Impact analysis — "what breaks if I change function X"

### Extended Language Support

- **LANG-01**: Additional language grammars beyond initial 5 (Java, C#, Ruby, etc.)

## Out of Scope

| Feature | Reason |
|---------|--------|
| Cloud/SaaS deployment | Local server with VPN access is sufficient for team |
| Real-time file watching | Git-hook re-indexing covers freshness; file watchers add complexity and race conditions |
| Code generation | AI clients (Claude, Copilot) handle generation; KB provides context only |
| Code review / linting | Separate problem domain with existing tools |
| IDE-specific UI components | MCP protocol handles the AI integration layer |
| External embedding APIs | Security concern (code IP), latency, cost — local models only |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| PARS-01 | Phase 2 | Complete |
| PARS-02 | Phase 2 | Complete |
| PARS-03 | Phase 2 | Complete |
| PARS-04 | Phase 2 | Complete |
| PARS-05 | Phase 2 | Complete |
| PARS-06 | Phase 2 | Complete |
| PARS-07 | Phase 3 | Complete |
| PARS-08 | Phase 3 | Pending |
| PARS-09 | Phase 2 | Complete |
| PARS-10 | Phase 5 | Pending |
| STOR-01 | Phase 2 | Complete |
| STOR-02 | Phase 3 | Complete |
| STOR-03 | Phase 2 | Complete |
| MCPS-01 | Phase 1 | Complete (01-01) |
| MCPS-02 | Phase 4 | Pending |
| MCPS-03 | Phase 4 | Pending |
| MCPS-04 | Phase 4 | Pending |
| OPS-01 | Phase 1 | Complete |
| OPS-02 | Phase 5 | Pending |
| OPS-03 | Phase 1 | Complete |
| UI-01 | Phase 6 | Pending |
| UI-02 | Phase 6 | Pending |
| UI-03 | Phase 6 | Pending |
| UI-04 | Phase 6 | Pending |

**Coverage:**
- v1 requirements: 24 total
- Mapped to phases: 24
- Unmapped: 0

---
*Requirements defined: 2026-03-02*
*Last updated: 2026-03-02 after roadmap creation*

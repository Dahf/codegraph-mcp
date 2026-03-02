import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * Factory function that creates and returns a new McpServer instance.
 *
 * Each MCP session gets its own server instance. Tools are registered
 * on this server — subsequent plans (Phase 2+) will add real tools here.
 */
export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'codegraph-mcp',
    version: '1.0.0',
  });

  // Tools will be registered here in future plans:
  // Phase 2: search_symbols, lookup_symbol, find_callers
  // Phase 3: semantic_search, get_context_bundle

  return server;
}

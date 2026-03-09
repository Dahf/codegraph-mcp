import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { QueryDeps } from './query/vector.js';
import { registerSearchCode } from './tools/searchCode.js';
import { registerLookupSymbol } from './tools/lookupSymbol.js';
import { registerContextBundle } from './tools/contextBundle.js';

/**
 * Factory function that creates and returns a new McpServer instance.
 *
 * Each MCP session gets its own server instance. Both search_code and
 * lookup_symbol tools are registered using the provided adapter dependencies.
 */
export function createMcpServer(deps: QueryDeps): McpServer {
  const server = new McpServer({
    name: 'codegraph-mcp',
    version: '1.0.0',
  });

  registerSearchCode(server, deps);
  registerLookupSymbol(server, deps);
  registerContextBundle(server, deps);

  return server;
}

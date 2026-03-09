import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { QueryDeps } from '../query/vector.js';

/**
 * Register the 'list_repos' MCP tool on the given server instance.
 *
 * Returns all configured repositories with their UUID, name, URL, and branch.
 * AI assistants should call this first to discover available repoIds before
 * using search_code or lookup_symbol.
 */
export function registerListRepos(server: McpServer, deps: QueryDeps): void {
  server.registerTool(
    'list_repos',
    {
      title: 'List Repositories',
      description:
        'List all indexed repositories with their IDs, names, and URLs. Call this FIRST to find the correct repoId before using search_code, lookup_symbol, or get_context_bundle. When a user mentions a repository by name, match it against the returned names to get the UUID.',
      inputSchema: {},
    },
    async (): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
      const repos = deps.config.repos.map((r) => ({
        id: r.id,
        name: r.name,
        url: r.url,
        branch: r.branch,
      }));

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ repos, count: repos.length }, null, 2),
          },
        ],
      };
    },
  );
}

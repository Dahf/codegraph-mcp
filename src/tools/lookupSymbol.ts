import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { QueryDeps } from '../query/vector.js';
import { lookupSymbol } from '../query/graph.js';

/**
 * Register the 'lookup_symbol' MCP tool on the given server instance.
 *
 * The tool performs exact (then prefix) symbol lookup across FalkorDB per-repo
 * graphs and returns source code, file location, and direct call neighbors.
 */
export function registerLookupSymbol(server: McpServer, deps: QueryDeps): void {
  server.registerTool(
    'lookup_symbol',
    {
      title: 'Symbol Lookup',
      description:
        'Find a function, class, or type definition by name. Returns source code, file location, and direct callers/callees from the call graph. IMPORTANT: When the user mentions a specific repository, call list_repos first to get its UUID and pass it as repoId.',
      inputSchema: z.object({
        name: z.string().describe('Symbol name to look up (function, class, or type name)'),
        repoId: z
          .string()
          .optional()
          .describe('Restrict lookup to a specific repository ID'),
      }),
    },
    async (args): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
      try {
        const results = await lookupSymbol(deps, args.name, args.repoId);

        // When repoId was specified and results are empty, surface a helpful message.
        if (args.repoId !== undefined && results.length === 0) {
          const repoConfigured = deps.config.repos.find((r) => r.id === args.repoId);
          if (repoConfigured === undefined) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Repo '${args.repoId}' has not been configured. Use POST /repos to add it.`,
                },
              ],
            };
          }
          return {
            content: [
              {
                type: 'text',
                text: `No symbol named '${args.name}' found in repo '${args.repoId}'. The repo may not have been indexed yet.`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ results, count: results.length }, null, 2),
            },
          ],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: 'Symbol lookup failed: ' + message }] };
      }
    },
  );
}

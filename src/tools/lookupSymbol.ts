import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { QueryDeps } from '../query/vector.js';
import { lookupSymbol } from '../query/graph.js';
import { resolveRepo } from '../query/resolveRepo.js';

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
        'Find a function, class, or type definition by name. Returns source code, file location, and direct callers/callees from the call graph. Use repoName to scope to a specific repository.',
      inputSchema: z.object({
        name: z.string().describe('Symbol name to look up (function, class, or type name)'),
        repoName: z
          .string()
          .optional()
          .describe('Repository name to search in (e.g. "RTFlex"). Case-insensitive.'),
        repoId: z.string().optional().describe('Repository UUID (alternative to repoName)'),
      }),
    },
    async (args): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
      try {
        const { repoId, error } = resolveRepo(deps.config, {
          repoId: args.repoId,
          repoName: args.repoName,
        });
        if (error) {
          return { content: [{ type: 'text', text: error }] };
        }

        const results = await lookupSymbol(deps, args.name, repoId);

        if (repoId !== undefined && results.length === 0) {
          const repoConfigured = deps.config.repos.find((r) => r.id === repoId);
          if (repoConfigured === undefined) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Repo '${repoId}' has not been configured. Use POST /repos to add it.`,
                },
              ],
            };
          }
          return {
            content: [
              {
                type: 'text',
                text: `No symbol named '${args.name}' found in repo '${repoConfigured.name}'. The repo may not have been indexed yet.`,
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

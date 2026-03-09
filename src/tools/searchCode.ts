import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { QueryDeps } from '../query/vector.js';
import { vectorSearch } from '../query/vector.js';

/**
 * Register the 'search_code' MCP tool on the given server instance.
 *
 * The tool performs semantic (vector) search over all indexed repositories
 * and returns ranked code snippets with file location and similarity scores.
 */
export function registerSearchCode(server: McpServer, deps: QueryDeps): void {
  server.registerTool(
    'search_code',
    {
      title: 'Semantic Code Search',
      description:
        'Search code by natural language query. Returns ranked code snippets with file location and similarity score. IMPORTANT: When the user mentions a specific repository, call list_repos first to get its UUID and pass it as repoId to avoid searching unrelated repos.',
      inputSchema: z.object({
        query: z.string().describe('Natural language description of code to find'),
        k: z.number().int().positive().optional().describe('Max results to return (default: 10)'),
        minScore: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe('Minimum similarity score 0–1 (default: 0.3)'),
        language: z
          .string()
          .optional()
          .describe('Filter by language e.g. "typescript", "python"'),
        symbolType: z
          .enum(['function', 'class', 'type'])
          .optional()
          .describe('Filter by symbol type'),
        repoId: z.string().optional().describe('Restrict search to a specific repository ID'),
      }),
    },
    async (args): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
      try {
        const results = await vectorSearch(deps, args);
        const response = {
          results,
          repoId: args.repoId ?? null,
          count: results.length,
        };
        return { content: [{ type: 'text', text: JSON.stringify(response, null, 2) }] };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: 'Search failed: ' + message }] };
      }
    },
  );
}

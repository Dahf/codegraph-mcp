import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { QueryDeps } from '../query/vector.js';
import { vectorSearch } from '../query/vector.js';
import { resolveRepo } from '../query/resolveRepo.js';

/**
 * Register the 'search_code' MCP tool on the given server instance.
 *
 * The tool performs semantic (vector) search over indexed repositories
 * and returns ranked code snippets with file location and similarity scores.
 */
export function registerSearchCode(server: McpServer, deps: QueryDeps): void {
  server.registerTool(
    'search_code',
    {
      title: 'Semantic Code Search',
      description:
        'Search code by natural language query. Returns ranked code snippets with similarity scores. Use repoName to scope to a specific repository (e.g. repoName: "RTFlex"). The query should describe WHAT code you are looking for, NOT which repository — use repoName for that.',
      inputSchema: z.object({
        query: z
          .string()
          .describe(
            'Natural language description of the code to find. Do NOT include the repository name here — use repoName instead.',
          ),
        repoName: z
          .string()
          .optional()
          .describe('Repository name to search in (e.g. "RTFlex"). Case-insensitive.'),
        repoId: z.string().optional().describe('Repository UUID (alternative to repoName)'),
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

        const results = await vectorSearch(deps, { ...args, repoId });
        const response = {
          results,
          repoId: repoId ?? null,
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

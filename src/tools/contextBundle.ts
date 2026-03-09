import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import pLimit from 'p-limit';
import type { QueryDeps } from '../query/vector.js';
import { vectorSearch } from '../query/vector.js';
import { getCallNeighbors, fetchSourceText } from '../query/graph.js';
import type { ContextBundle, ContextChunk } from '../types/index.js';

// ── Token budget heuristic ────────────────────────────────────────────────────

const CHARS_PER_TOKEN = 4;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// ── Bundle assembly ───────────────────────────────────────────────────────────

/**
 * Assemble a token-budgeted context bundle from vector search seed matches
 * and call-graph neighbor expansion.
 *
 * 1. Vector search (k=20) provides seed matches ordered by score descending.
 * 2. Seeds fill the budget first; duplicates are skipped via a Set.
 * 3. Each seed's callers/callees are fetched from FalkorDB in parallel (p-limit 5).
 * 4. Related chunks fill remaining budget in declaration order.
 */
async function assembleBundle(
  deps: QueryDeps,
  query: string,
  maxTokens: number,
  opts?: { repoId?: string },
): Promise<ContextBundle> {
  const seeds = await vectorSearch(deps, { query, k: 20, repoId: opts?.repoId });

  const budget = maxTokens * CHARS_PER_TOKEN;
  let usedChars = 0;
  const seen = new Set<string>();
  const relevantCode: ContextChunk[] = [];
  const relatedCode: ContextChunk[] = [];
  let budgetReached = false;

  // Phase 1: fill Relevant Code from vector search seeds (highest score first).
  for (const result of seeds) {
    const key = `${result.repoId}:${result.filePath}:${result.symbolName}`;
    if (seen.has(key)) continue;
    if (usedChars + result.sourceText.length > budget) {
      budgetReached = true;
      break;
    }
    seen.add(key);
    relevantCode.push({
      filePath: result.filePath,
      startLine: result.startLine,
      endLine: result.endLine,
      language: result.language,
      repoId: result.repoId,
      symbolName: result.symbolName,
      sourceText: result.sourceText,
    });
    usedChars += result.sourceText.length;
  }

  // Phase 2: expand each seed's call-graph neighbors (concurrency 5).
  const limit = pLimit(5);

  await Promise.all(
    relevantCode.map((chunk) =>
      limit(async () => {
        const { callers, callees } = await getCallNeighbors(
          deps,
          chunk.symbolName,
          chunk.filePath,
          chunk.repoId,
        );

        // Process callers then callees.
        const neighbors: Array<{
          name: string;
          filePath: string;
          repoId: string;
          relation: string;
        }> = [
          ...callers.map((c) => ({ ...c, relation: `caller of ${chunk.symbolName}` })),
          ...callees.map((c) => ({ ...c, relation: `callee of ${chunk.symbolName}` })),
        ];

        for (const neighbor of neighbors) {
          const key = `${neighbor.repoId}:${neighbor.filePath}:${neighbor.name}`;
          if (seen.has(key)) continue;
          if (usedChars >= budget) {
            budgetReached = true;
            continue;
          }

          const sourceText = await fetchSourceText(
            deps,
            neighbor.name,
            neighbor.filePath,
            neighbor.repoId,
          );

          // Skip symbols not indexed in LanceDB (e.g. builtins).
          if (sourceText === '') continue;

          if (usedChars + sourceText.length > budget) {
            budgetReached = true;
            continue;
          }

          seen.add(key);
          // Line info not available from graph — use 0 as sentinel.
          relatedCode.push({
            filePath: neighbor.filePath,
            startLine: 0,
            endLine: 0,
            language: chunk.language,
            repoId: neighbor.repoId,
            symbolName: neighbor.name,
            sourceText,
            relationNote: neighbor.relation,
          });
          usedChars += sourceText.length;
        }
      }),
    ),
  );

  return { relevantCode, relatedCode, totalChars: usedChars, budgetReached };
}

// ── Text formatting ───────────────────────────────────────────────────────────

/**
 * Render a ContextBundle as structured Markdown text.
 *
 * Format:
 *   ## Relevant Code
 *   ### src/foo/bar.ts (lines 42–67) [repoId: my-repo]
 *   ```typescript
 *   <sourceText>
 *   ```
 *
 *   ## Related Code
 *   ### src/foo/baz.ts (lines 10–25) [repoId: my-repo] (caller of bar)
 *   ```typescript
 *   <sourceText>
 *   ```
 */
function formatBundle(bundle: ContextBundle): string {
  if (bundle.relevantCode.length === 0) {
    return 'No relevant code found. Ensure repositories have been indexed with POST /repos/:id/index';
  }

  const lines: string[] = [];

  lines.push('## Relevant Code\n');
  for (const chunk of bundle.relevantCode) {
    const lineRange =
      chunk.startLine > 0 ? `lines ${chunk.startLine}–${chunk.endLine}` : 'lines unknown';
    lines.push(`### ${chunk.filePath} (${lineRange}) [repoId: ${chunk.repoId}]`);
    lines.push(`\`\`\`${chunk.language}`);
    lines.push(chunk.sourceText);
    lines.push('```\n');
  }

  lines.push('## Related Code\n');
  for (const chunk of bundle.relatedCode) {
    const lineRange =
      chunk.startLine > 0 ? `lines ${chunk.startLine}–${chunk.endLine}` : 'lines unknown';
    const relation = chunk.relationNote ? ` (${chunk.relationNote})` : '';
    lines.push(`### ${chunk.filePath} (${lineRange}) [repoId: ${chunk.repoId}]${relation}`);
    lines.push(`\`\`\`${chunk.language}`);
    lines.push(chunk.sourceText);
    lines.push('```\n');
  }

  return lines.join('\n');
}

// ── Tool registration ─────────────────────────────────────────────────────────

/**
 * Register the 'get_context_bundle' MCP tool on the given server instance.
 *
 * The tool assembles a pre-built, token-budgeted context package by combining:
 * - Vector search seed matches (most relevant code)
 * - Call-graph neighbors of seed matches (related code)
 */
export function registerContextBundle(server: McpServer, deps: QueryDeps): void {
  server.registerTool(
    'get_context_bundle',
    {
      title: 'Context Bundle',
      description:
        'Assemble a pre-built context package for a development task. Returns the most relevant code, including call-graph neighbors, formatted for AI consumption. IMPORTANT: When the user mentions a specific repository, call list_repos first to get its UUID and pass it as repoId to scope results.',
      inputSchema: z.object({
        task: z.string().describe('Description of the development task or question requiring context'),
        max_tokens: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Token budget for the context bundle (default: 4000)'),
        repoId: z.string().optional().describe('Restrict to a specific repository ID'),
      }),
    },
    async (args): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
      try {
        const maxTokens = args.max_tokens ?? 4000;
        const bundle = await assembleBundle(deps, args.task, maxTokens, { repoId: args.repoId });
        const formattedOutput = formatBundle(bundle);
        return { content: [{ type: 'text', text: formattedOutput }] };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: 'Context bundle assembly failed: ' + message }] };
      }
    },
  );
}

import * as lancedb from '@lancedb/lancedb';
import type { LanceDBAdapter } from '../adapters/lancedb.js';
import type { FalkorDBAdapter } from '../adapters/falkordb.js';
import type { OllamaAdapter } from '../adapters/ollama.js';
import type { Config, SearchResult } from '../types/index.js';
import { EMBED_MODEL } from '../constants.js';

export interface QueryDeps {
  lanceAdapter: LanceDBAdapter;
  falkorAdapter: FalkorDBAdapter;
  ollamaAdapter: OllamaAdapter;
  config: Config;
}

/**
 * Build a SQL AND-joined WHERE predicate from optional filter fields.
 * LanceDB .where() accepts SQL strings, so values use single-quoted SQL literals.
 * Returns undefined when no filters are provided.
 */
function buildWhereClause(opts: {
  repoId?: string;
  language?: string;
  symbolType?: string;
}): string | undefined {
  const parts: string[] = [];
  if (opts.repoId !== undefined) {
    parts.push(`repoId = '${opts.repoId}'`);
  }
  if (opts.language !== undefined) {
    parts.push(`language = '${opts.language}'`);
  }
  if (opts.symbolType !== undefined) {
    parts.push(`symbolType = '${opts.symbolType}'`);
  }
  return parts.length > 0 ? parts.join(' AND ') : undefined;
}

/**
 * Search the LanceDB embeddings table using cosine similarity.
 *
 * Embeds the query string, runs a vector search, applies a score threshold,
 * and returns ranked SearchResult objects. Returns an empty array when the
 * embeddings table does not yet exist (fresh install before any indexing).
 */
export async function vectorSearch(
  deps: QueryDeps,
  opts: {
    query: string;
    k?: number;
    minScore?: number;
    language?: string;
    symbolType?: string;
    repoId?: string;
  },
): Promise<SearchResult[]> {
  const K = opts.k ?? 10;
  const minScore = opts.minScore ?? 0.3;
  // For cosine distance: distance = 1 - similarity, so lower distance = more similar.
  const maxDistance = 1 - minScore;

  // Embed the query text using the shared model.
  const vectors = await deps.ollamaAdapter.embed(opts.query, EMBED_MODEL);
  const queryVector = vectors[0]!;

  // Build optional WHERE clause for metadata filters.
  const whereClause = buildWhereClause({
    repoId: opts.repoId,
    language: opts.language,
    symbolType: opts.symbolType,
  });

  // Open the embeddings table — return empty array if it doesn't exist yet.
  let table: Awaited<ReturnType<LanceDBAdapter['openTable']>>;
  try {
    table = await deps.lanceAdapter.openTable('embeddings');
  } catch {
    // Table doesn't exist (fresh install before indexing).
    return [];
  }

  // Build and execute the vector search query.
  // table.search() returns VectorQuery | Query; passing a number[] always produces a VectorQuery.
  let searchQuery = (table.search(queryVector) as lancedb.VectorQuery)
    .distanceType('cosine')
    .limit(K);
  if (whereClause !== undefined) {
    searchQuery = searchQuery.where(whereClause);
  }

  const rows = await searchQuery.toArray();

  // Filter by distance threshold and map to SearchResult.
  return rows
    .filter((row: Record<string, unknown>) => (row._distance as number) <= maxDistance)
    .map((row: Record<string, unknown>) => ({
      sourceText: row.sourceText as string,
      filePath: row.filePath as string,
      symbolName: row.symbolName as string,
      symbolType: row.symbolType as string,
      startLine: row.startLine as number,
      endLine: row.endLine as number,
      language: row.language as string,
      repoId: row.repoId as string,
      score: 1 - (row._distance as number),
    }));
}

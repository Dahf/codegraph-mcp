import type { QueryDeps } from './vector.js';
import type { SymbolResult } from '../types/index.js';

/**
 * Escape a string value for use in a FalkorDB/SQL single-quoted literal.
 * Single quotes are doubled per SQL escaping rules.
 */
function escapeSql(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Fetch the full sourceText for a symbol from the LanceDB embeddings table
 * using a scalar scan (no vector embedding needed).
 *
 * Returns an empty string if the table does not exist or the symbol has no
 * stored embedding.
 */
export async function fetchSourceText(
  deps: QueryDeps,
  symbolName: string,
  filePath: string,
  repoId: string,
): Promise<string> {
  try {
    const table = await deps.lanceAdapter.openTable('embeddings');
    const where =
      `symbolName = '${escapeSql(symbolName)}' AND ` +
      `filePath = '${escapeSql(filePath)}' AND ` +
      `repoId = '${escapeSql(repoId)}'`;
    const rows = await table.query().where(where).limit(1).toArray();
    return (rows[0] as Record<string, unknown>)?.sourceText as string ?? '';
  } catch {
    // Table may not exist (fresh install) or symbol not indexed yet.
    return '';
  }
}

/**
 * Return the direct callers and callees of a named Function node in a specific
 * repo graph by traversing CALLS edges.
 *
 * Returns empty arrays when the function is not found or the graph does not
 * exist (repo not yet indexed).
 */
export async function getCallNeighbors(
  deps: QueryDeps,
  symbolName: string,
  filePath: string,
  repoId: string,
): Promise<{
  callers: Array<{ name: string; filePath: string; repoId: string }>;
  callees: Array<{ name: string; filePath: string; repoId: string }>;
}> {
  try {
    const graph = deps.falkorAdapter.selectGraph('codegraph-' + repoId);
    const params = { name: symbolName, filePath, repoId };

    const [callersResult, calleesResult] = await Promise.all([
      graph.query<{ caller: Record<string, unknown> }>(
        'MATCH (caller:Function)-[:CALLS]->(fn:Function {name: $name, filePath: $filePath, repoId: $repoId}) RETURN caller',
        { params },
      ),
      graph.query<{ callee: Record<string, unknown> }>(
        'MATCH (fn:Function {name: $name, filePath: $filePath, repoId: $repoId})-[:CALLS]->(callee:Function) RETURN callee',
        { params },
      ),
    ]);

    const callers = (callersResult.data ?? []).map((row) => ({
      name: row.caller.name as string,
      filePath: row.caller.filePath as string,
      repoId: (row.caller.repoId as string | undefined) ?? repoId,
    }));

    const callees = (calleesResult.data ?? []).map((row) => ({
      name: row.callee.name as string,
      filePath: row.callee.filePath as string,
      repoId: (row.callee.repoId as string | undefined) ?? repoId,
    }));

    return { callers, callees };
  } catch {
    // Graph may not exist if repo has not been indexed yet.
    return { callers: [], callees: [] };
  }
}

/** A raw graph hit before call-neighbor expansion */
interface RawHit {
  node: Record<string, unknown>;
  symbolType: 'function' | 'class' | 'type';
}

/**
 * Run three separate exact-match queries (Function, Class, Type) against a
 * single repo graph and return combined raw hits.
 */
async function exactMatchQuery(
  deps: QueryDeps,
  repoId: string,
  name: string,
): Promise<RawHit[]> {
  const graph = deps.falkorAdapter.selectGraph('codegraph-' + repoId);
  const params = { name, repoId };

  const results = await Promise.allSettled([
    graph.query<{ fn: Record<string, unknown> }>(
      'MATCH (fn:Function {name: $name, repoId: $repoId}) RETURN fn',
      { params },
    ),
    graph.query<{ fn: Record<string, unknown> }>(
      'MATCH (fn:Class {name: $name, repoId: $repoId}) RETURN fn',
      { params },
    ),
    graph.query<{ fn: Record<string, unknown> }>(
      'MATCH (fn:Type {name: $name, repoId: $repoId}) RETURN fn',
      { params },
    ),
  ]);

  const hits: RawHit[] = [];
  const kinds: Array<'function' | 'class' | 'type'> = ['function', 'class', 'type'];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result?.status === 'fulfilled') {
      for (const row of result.value.data ?? []) {
        hits.push({ node: row.fn, symbolType: kinds[i]! });
      }
    }
  }

  return hits;
}

/**
 * Run three separate prefix-match queries (Function, Class, Type) against a
 * single repo graph and return combined raw hits.
 */
async function prefixMatchQuery(
  deps: QueryDeps,
  repoId: string,
  prefix: string,
): Promise<RawHit[]> {
  const graph = deps.falkorAdapter.selectGraph('codegraph-' + repoId);
  const params = { prefix, repoId };

  const results = await Promise.allSettled([
    graph.query<{ fn: Record<string, unknown> }>(
      'MATCH (fn:Function {repoId: $repoId}) WHERE fn.name STARTS WITH $prefix RETURN fn',
      { params },
    ),
    graph.query<{ fn: Record<string, unknown> }>(
      'MATCH (fn:Class {repoId: $repoId}) WHERE fn.name STARTS WITH $prefix RETURN fn',
      { params },
    ),
    graph.query<{ fn: Record<string, unknown> }>(
      'MATCH (fn:Type {repoId: $repoId}) WHERE fn.name STARTS WITH $prefix RETURN fn',
      { params },
    ),
  ]);

  const hits: RawHit[] = [];
  const kinds: Array<'function' | 'class' | 'type'> = ['function', 'class', 'type'];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result?.status === 'fulfilled') {
      for (const row of result.value.data ?? []) {
        hits.push({ node: row.fn, symbolType: kinds[i]! });
      }
    }
  }

  return hits;
}

/**
 * Expand a raw graph hit into a full SymbolResult by fetching source text and
 * (for functions) call neighbors.
 */
async function expandHit(
  deps: QueryDeps,
  hit: RawHit,
  repoId: string,
): Promise<SymbolResult> {
  const node = hit.node;
  const symbolName = node.name as string;
  const filePath = node.filePath as string;

  const sourceText = await fetchSourceText(deps, symbolName, filePath, repoId);

  let callers: Array<{ name: string; filePath: string; repoId: string }> = [];
  let callees: Array<{ name: string; filePath: string; repoId: string }> = [];

  if (hit.symbolType === 'function') {
    const neighbors = await getCallNeighbors(deps, symbolName, filePath, repoId);
    callers = neighbors.callers;
    callees = neighbors.callees;
  }

  return {
    symbolType: hit.symbolType,
    symbolName,
    filePath,
    startLine: node.startLine as number,
    endLine: node.endLine as number,
    language: node.language as string,
    repoId,
    sourceText,
    callers,
    callees,
  };
}

/**
 * Look up a named symbol across FalkorDB per-repo graphs.
 *
 * Strategy:
 * 1. Exact match across all target repos (three separate queries per repo for
 *    Function, Class, and Type nodes).
 * 2. If zero exact hits across ALL repos, fall back to prefix match.
 *
 * When repoId is specified, only that repo is queried. When the repoId is not
 * found in config.repos, returns [] immediately (repo not configured).
 *
 * For Function hits: callers/callees are fetched via CALLS edges.
 * For Class/Type hits: callers and callees are empty arrays.
 *
 * Repos that have not been indexed yet (graph missing) return 0 hits and do
 * not cause errors.
 */
export async function lookupSymbol(
  deps: QueryDeps,
  symbolName: string,
  repoId?: string,
): Promise<SymbolResult[]> {
  // Determine which repos to query.
  let repoIds: string[];
  if (repoId !== undefined) {
    const found = deps.config.repos.find((r) => r.id === repoId);
    if (found === undefined) {
      // Repo not configured — caller should surface a descriptive message.
      return [];
    }
    repoIds = [repoId];
  } else {
    repoIds = deps.config.repos.map((r) => r.id);
  }

  // Pass 1: exact match across all repos in parallel.
  const exactResultsPerRepo = await Promise.all(
    repoIds.map(async (rid) => {
      try {
        return { repoId: rid, hits: await exactMatchQuery(deps, rid, symbolName) };
      } catch {
        return { repoId: rid, hits: [] as RawHit[] };
      }
    }),
  );

  const totalExact = exactResultsPerRepo.reduce((sum, r) => sum + r.hits.length, 0);

  let hitsPerRepo: Array<{ repoId: string; hits: RawHit[] }>;

  if (totalExact > 0) {
    hitsPerRepo = exactResultsPerRepo;
  } else {
    // Pass 2: prefix match — only when zero exact matches across ALL repos.
    hitsPerRepo = await Promise.all(
      repoIds.map(async (rid) => {
        try {
          return { repoId: rid, hits: await prefixMatchQuery(deps, rid, symbolName) };
        } catch {
          return { repoId: rid, hits: [] as RawHit[] };
        }
      }),
    );
  }

  // Expand all hits to full SymbolResult objects.
  const expansions: Array<Promise<SymbolResult>> = [];
  for (const { repoId: rid, hits } of hitsPerRepo) {
    for (const hit of hits) {
      expansions.push(expandHit(deps, hit, rid));
    }
  }

  return Promise.all(expansions);
}

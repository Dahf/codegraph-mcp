import type { Graph } from '@falkordb/graph';

/**
 * Reads the checkpoint for a given repo from FalkorDB.
 * Returns the set of file paths that have already been processed.
 * Returns an empty Set if no checkpoint exists.
 */
export async function readCheckpoint(graph: Graph, repoId: string): Promise<Set<string>> {
  const result = await graph.query(
    'MATCH (c:Checkpoint {repoId: $repoId}) RETURN c.processedFiles',
    { params: { repoId } },
  );

  if (!result.data || result.data.length === 0) return new Set();

  const json = (result.data[0] as Record<string, unknown>)?.['c.processedFiles'] as string | undefined;
  if (!json) return new Set();

  return new Set(JSON.parse(json) as string[]);
}

/**
 * Writes (upserts) a checkpoint for a given repo to FalkorDB.
 * Uses MERGE so calling this multiple times is safe — no duplicate nodes.
 * Serializes the Set as a JSON array string.
 */
export async function writeCheckpoint(
  graph: Graph,
  repoId: string,
  processedFiles: Set<string>,
): Promise<void> {
  await graph.query(
    `MERGE (c:Checkpoint {repoId: $repoId})
     SET c.processedFiles = $files, c.updatedAt = $ts`,
    {
      params: {
        repoId,
        files: JSON.stringify([...processedFiles]),
        ts: Date.now(),
      },
    },
  );
}

/**
 * Clears the processedFiles checkpoint for a given repo in FalkorDB.
 * Uses SET c.processedFiles = null instead of DELETE so the Checkpoint node
 * and its lastCommit property are preserved across full re-index runs.
 */
export async function clearCheckpoint(graph: Graph, repoId: string): Promise<void> {
  await graph.query(
    'MATCH (c:Checkpoint {repoId: $repoId}) SET c.processedFiles = null',
    { params: { repoId } },
  );
}

/**
 * Reads the last indexed commit SHA for a given repo from FalkorDB.
 * Returns null if no Checkpoint node exists or lastCommit is not set.
 */
export async function readLastCommit(graph: Graph, repoId: string): Promise<string | null> {
  const result = await graph.query(
    'MATCH (c:Checkpoint {repoId: $repoId}) RETURN c.lastCommit',
    { params: { repoId } },
  );
  if (!result.data || result.data.length === 0) return null;
  return (result.data[0] as Record<string, unknown>)?.['c.lastCommit'] as string ?? null;
}

/**
 * Writes (upserts) the last indexed commit SHA for a given repo to FalkorDB.
 * Uses MERGE so calling this multiple times is safe — no duplicate nodes.
 * Bootstraps the Checkpoint node on first full index run.
 */
export async function writeLastCommit(graph: Graph, repoId: string, sha: string): Promise<void> {
  await graph.query(
    `MERGE (c:Checkpoint {repoId: $repoId})
     SET c.lastCommit = $sha, c.updatedAt = $ts`,
    { params: { repoId, sha, ts: Date.now() } },
  );
}

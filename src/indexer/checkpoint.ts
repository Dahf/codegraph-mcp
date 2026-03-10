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
 * Deletes the checkpoint node for a given repo from FalkorDB.
 * Called at the start of a fresh (non-resume) index run to ensure
 * stale checkpoint data does not cause files to be skipped.
 */
export async function clearCheckpoint(graph: Graph, repoId: string): Promise<void> {
  await graph.query(
    'MATCH (c:Checkpoint {repoId: $repoId}) DELETE c',
    { params: { repoId } },
  );
}

import type { OllamaAdapter } from '../adapters/ollama.js';
import type { LanceDBAdapter } from '../adapters/lancedb.js';
import type { CodeChunk } from './chunker.js';

// ── New streaming-pipeline functions ─────────────────────────────────────────

/**
 * Embed a single code chunk via Ollama. Returns a row object ready for LanceDB
 * storage, or null if embedding fails. Does NOT throw — errors are logged and
 * returned as null.
 *
 * Designed for use as a p-queue task in the streaming pipeline (Plan 07-04).
 * Concurrency is controlled by the queue, not by p-limit inside this function.
 */
export async function embedSingleChunk(
  chunk: CodeChunk,
  repoId: string,
  ollamaAdapter: OllamaAdapter,
  model: string,
): Promise<Record<string, unknown> | null> {
  try {
    const result = await ollamaAdapter.embed(chunk.sourceText, model);
    // embed() returns number[][] (one vector per input text); we sent a single string
    const embedding = result[0];
    if (!embedding) {
      console.warn(`[embedder] Empty embedding for ${chunk.symbolName}`);
      return null;
    }
    return {
      vector: embedding,
      repoId,
      filePath: chunk.filePath,
      symbolName: chunk.symbolName,
      symbolType: chunk.symbolType,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      language: chunk.language,
      sourceText: chunk.sourceText,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[embedder] Failed to embed ${chunk.symbolName}: ${msg}`);
    return null;
  }
}

/**
 * Store pre-built embedding rows into LanceDB. Handles table creation and
 * delete-before-insert pattern for re-indexing.
 *
 * No-op when rows is empty.
 */
export async function storeEmbeddingRows(
  rows: Record<string, unknown>[],
  repoId: string,
  lanceAdapter: LanceDBAdapter,
): Promise<void> {
  if (rows.length === 0) return;

  const tableNames = await lanceAdapter.getConnection().tableNames();
  const tableExists = tableNames.includes('embeddings');

  if (tableExists) {
    // Delete old rows for this repo, then add new ones
    await lanceAdapter.deleteRows('embeddings', `repoId = '${repoId}'`);
    await lanceAdapter.addRows('embeddings', rows);
  } else {
    // Create table with first batch
    await lanceAdapter.createOrOverwriteTable('embeddings', rows);
  }
}


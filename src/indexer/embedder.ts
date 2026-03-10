import pLimit from 'p-limit';
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

// ── Backward-compatible bulk function ────────────────────────────────────────

/**
 * Orchestrates embedding generation and vector storage for code chunks.
 *
 * For each chunk, calls Ollama to generate an embedding vector, then stores
 * successful results in LanceDB. Uses p-limit for concurrency control.
 *
 * Re-indexing is handled via delete-before-insert: existing rows for the
 * given repoId are removed before new rows are added.
 *
 * Individual embedding failures are logged and skipped -- they do not abort
 * the batch. The caller receives counts of stored vs failed embeddings.
 *
 * @deprecated Use embedSingleChunk() + storeEmbeddingRows() from the streaming
 *   pipeline (07-04). This bulk function will be removed after the pipeline
 *   refactor is complete.
 */
export async function embedAndStore(
  chunks: CodeChunk[],
  repoId: string,
  ollamaAdapter: OllamaAdapter,
  lanceAdapter: LanceDBAdapter,
  options: { model: string; concurrency: number },
): Promise<{ stored: number; failed: number }> {
  const limit = pLimit(options.concurrency);

  // Generate embeddings with concurrency control
  const tasks = chunks.map((chunk) =>
    limit(() => embedSingleChunk(chunk, repoId, ollamaAdapter, options.model)),
  );

  const results = await Promise.all(tasks);

  // Collect successful rows
  const rows: Record<string, unknown>[] = results.filter(
    (r): r is Record<string, unknown> => r !== null,
  );

  // Store in LanceDB (skip if all embeddings failed)
  await storeEmbeddingRows(rows, repoId, lanceAdapter);

  return { stored: rows.length, failed: chunks.length - rows.length };
}

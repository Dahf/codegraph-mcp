import pLimit from 'p-limit';
import type { OllamaAdapter } from '../adapters/ollama.js';
import type { LanceDBAdapter } from '../adapters/lancedb.js';
import type { CodeChunk } from './chunker.js';

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
  const tasks = chunks.map((chunk, idx) =>
    limit(async () => {
      try {
        const result = await ollamaAdapter.embed(chunk.sourceText, options.model);
        // embed() returns number[][] (one vector per input text); we sent a single string
        const embedding = result[0];
        if (!embedding) {
          console.warn(`[embedder] Empty embedding for ${chunk.symbolName}`);
          return null;
        }
        return { idx, embedding };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[embedder] Failed to embed ${chunk.symbolName}: ${msg}`);
        return null;
      }
    }),
  );

  const results = await Promise.all(tasks);

  // Build row data from successful results
  const rows: Record<string, unknown>[] = [];
  for (const r of results) {
    if (r === null) continue;
    const chunk = chunks[r.idx]!;
    rows.push({
      vector: r.embedding,
      repoId,
      filePath: chunk.filePath,
      symbolName: chunk.symbolName,
      symbolType: chunk.symbolType,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      language: chunk.language,
      sourceText: chunk.sourceText,
    });
  }

  // Store in LanceDB (skip if all embeddings failed)
  if (rows.length > 0) {
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

  return { stored: rows.length, failed: chunks.length - rows.length };
}

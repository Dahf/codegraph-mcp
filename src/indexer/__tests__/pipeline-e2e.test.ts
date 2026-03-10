/**
 * E2E integration test for IndexPipeline.
 *
 * Clones a real (small) public GitHub repo and runs the full pipeline
 * with mocked external services (FalkorDB, Ollama, LanceDB) but real:
 *   - Git clone
 *   - File walking (async generator)
 *   - Tree-sitter parsing
 *   - Symbol extraction
 *   - Chunking
 *
 * This validates the entire streaming two-pass architecture end-to-end.
 *
 * Tagged "e2e" so it can be run separately: npx vitest run --testNamePattern e2e
 */

import { describe, it, expect, vi, afterAll } from 'vitest';
import { rm, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { IndexPipeline } from '../pipeline.js';
import type { Config, RepoConfig } from '../../types/index.js';

// ── Tiny public repo — sindresorhus/ky (small, TypeScript, fast clone) ──
const TEST_REPO_URL = 'https://github.com/sindresorhus/ky.git';
const TEST_REPO_BRANCH = 'main';

// Temp directory for clone + data
let tmpDir: string;

// ── Mock adapters that record calls without requiring real services ──

function makeMockGraph() {
  const nodes: Array<{ query: string; params?: Record<string, unknown> }> = [];
  return {
    query: vi.fn(async (query: string, options?: { params?: Record<string, unknown> }) => {
      nodes.push({ query, params: options?.params });
      // Return empty results for all queries (no existing data)
      return { data: [] };
    }),
    _nodes: nodes,
  };
}

function makeMockFalkorAdapter(mockGraph: ReturnType<typeof makeMockGraph>) {
  return {
    selectGraph: vi.fn().mockReturnValue(mockGraph),
    connect: vi.fn().mockResolvedValue(undefined),
    healthCheck: vi.fn().mockResolvedValue({ ok: true, message: 'mock' }),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function makeMockOllamaAdapter() {
  // Return a fake 8-dim embedding vector for every embed call
  return {
    embed: vi.fn(async () => [[0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]]),
    connect: vi.fn().mockResolvedValue(undefined),
    healthCheck: vi.fn().mockResolvedValue({ ok: true, message: 'mock' }),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function makeMockLanceAdapter() {
  const storedRows: Record<string, unknown>[] = [];
  return {
    getConnection: vi.fn().mockReturnValue({
      tableNames: vi.fn(async () =>
        storedRows.length > 0 ? ['embeddings'] : [],
      ),
    }),
    createOrOverwriteTable: vi.fn(async (_name: string, rows: Record<string, unknown>[]) => {
      storedRows.push(...rows);
    }),
    addRows: vi.fn(async (_name: string, rows: Record<string, unknown>[]) => {
      storedRows.push(...rows);
    }),
    deleteRows: vi.fn().mockResolvedValue(undefined),
    openTable: vi.fn().mockResolvedValue({}),
    connect: vi.fn().mockResolvedValue(undefined),
    healthCheck: vi.fn().mockResolvedValue({ ok: true, message: 'mock' }),
    close: vi.fn().mockResolvedValue(undefined),
    _storedRows: storedRows,
  };
}

describe('IndexPipeline E2E', () => {
  // Increase timeout — git clone can take a few seconds
  afterAll(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('e2e: clones a real repo and indexes it through the full streaming pipeline', async () => {
    // Create temp directory for test data
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'mcprag-e2e-'));

    const mockGraph = makeMockGraph();
    const falkorAdapter = makeMockFalkorAdapter(mockGraph);
    const ollamaAdapter = makeMockOllamaAdapter();
    const lanceAdapter = makeMockLanceAdapter();

    const config: Config = {
      port: 4444,
      dataDir: tmpDir,
      falkordb: { host: 'localhost', port: 6379 },
      lancedb: { path: path.join(tmpDir, 'vectors') },
      ollama: { host: 'http://localhost:11434' },
      repos: [],
      indexer: {
        maxFileSizeBytes: 500_000,     // 500KB — skip large generated files
        embeddingConcurrency: 2,
        memoryThresholdRatio: 0.90,
        embeddingQueueSize: 50,
      },
    };

    const repo: RepoConfig = {
      id: 'e2e-test-repo',
      name: 'ky',
      url: TEST_REPO_URL,
      branch: TEST_REPO_BRANCH,
      addedAt: new Date().toISOString(),
    };

    const pipeline = new IndexPipeline(
      falkorAdapter as never,
      ollamaAdapter as never,
      lanceAdapter as never,
      config,
    );

    const result = await pipeline.run(repo);

    // ── Assertions ──

    // 1. Files were processed
    console.log(`[e2e] Files processed: ${result.filesProcessed}`);
    console.log(`[e2e] Symbols extracted: ${result.symbolsExtracted}`);
    console.log(`[e2e] Edges created: ${result.edgesCreated}`);
    console.log(`[e2e] Embeddings stored: ${result.embeddingsStored}`);
    console.log(`[e2e] Failed files: ${result.failedFiles.length}`);

    expect(result.filesProcessed).toBeGreaterThan(0);
    expect(result.repoId).toBe('e2e-test-repo');

    // 2. Symbols were extracted (ky has TypeScript source files with functions/classes)
    expect(result.symbolsExtracted).toBeGreaterThan(0);

    // 3. Graph was set up correctly
    expect(falkorAdapter.selectGraph).toHaveBeenCalledWith('codegraph-e2e-test-repo');

    // 4. Graph operations happened — clearGraph, createIndexes, writeFileSymbols
    const queries = mockGraph._nodes.map(n => n.query);
    // Should have DETACH DELETE (clearGraph)
    expect(queries.some(q => q.includes('DETACH DELETE'))).toBe(true);
    // Should have CREATE INDEX queries
    expect(queries.some(q => q.includes('CREATE INDEX'))).toBe(true);
    // Should have MERGE queries (writeFileSymbols)
    expect(queries.some(q => q.includes('MERGE'))).toBe(true);

    // 5. Embeddings were generated via Ollama mock
    expect(ollamaAdapter.embed).toHaveBeenCalled();
    const embedCallCount = ollamaAdapter.embed.mock.calls.length;
    console.log(`[e2e] Ollama embed calls: ${embedCallCount}`);
    expect(embedCallCount).toBeGreaterThan(0);

    // 6. Embedding rows were stored in LanceDB
    const totalLanceWrites =
      lanceAdapter.createOrOverwriteTable.mock.calls.length +
      lanceAdapter.addRows.mock.calls.length;
    expect(totalLanceWrites).toBeGreaterThan(0);
    console.log(`[e2e] LanceDB write calls: ${totalLanceWrites}`);
    console.log(`[e2e] Total rows stored: ${lanceAdapter._storedRows.length}`);

    // 7. Each stored row has the expected shape
    if (lanceAdapter._storedRows.length > 0) {
      const sampleRow = lanceAdapter._storedRows[0];
      expect(sampleRow).toHaveProperty('vector');
      expect(sampleRow).toHaveProperty('repoId', 'e2e-test-repo');
      expect(sampleRow).toHaveProperty('filePath');
      expect(sampleRow).toHaveProperty('symbolName');
      expect(sampleRow).toHaveProperty('sourceText');
    }

    // 8. Checkpoint was cleared at end (fresh run completes successfully)
    const deleteQueries = queries.filter(q => q.includes('DELETE') && q.includes('Checkpoint'));
    // At least 2 DELETE Checkpoint queries: one at start (clearCheckpoint) and one at end
    expect(deleteQueries.length).toBeGreaterThanOrEqual(2);

    // 9. Clone directory should be cleaned up (finally block)
    const { existsSync } = await import('node:fs');
    const clonePath = path.join(tmpDir, 'repos', 'e2e-test-repo');
    expect(existsSync(clonePath)).toBe(false);

    // 10. No catastrophic failures
    if (result.failedFiles.length > 0) {
      console.log(`[e2e] Failed files:`, result.failedFiles.slice(0, 5));
    }
    // Allow some failures (binary files, unsupported languages) but not too many
    const failureRate = result.failedFiles.length / (result.filesProcessed + result.failedFiles.length);
    expect(failureRate).toBeLessThan(0.5); // Less than 50% failure rate
  }, 120_000); // 2 minute timeout for git clone + full indexing
});

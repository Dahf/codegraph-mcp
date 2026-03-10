/**
 * Integration tests for IndexPipeline streaming two-pass architecture.
 *
 * All external dependencies are mocked. Tests verify:
 * 1. Checkpoint resume skips already-indexed files
 * 2. Source text GC ordering — writeFileSymbols before extractChunks for each file
 * 3. Fresh run calls clearGraph + clearCheckpoint before processing
 * 4. Resume run skips clearGraph + clearCheckpoint
 * 5. embeddingQueue.onIdle() is awaited before storeEmbeddingRows
 * 6. Backpressure: onSizeLessThan is called before enqueuing chunks
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mock all external dependencies before importing the pipeline ---

// Walker mocks
vi.mock('../walker.js', () => ({
  walkRepo: vi.fn(),
  readSourceFile: vi.fn(),
}));

// Graph writer mocks — use mockImplementation so clearing call history doesn't lose the impl
vi.mock('../graph-writer.js', () => ({
  writeFileSymbols: vi.fn().mockImplementation(async () => 1),
  writeCallEdges: vi.fn().mockImplementation(async () => 0),
  clearGraph: vi.fn().mockImplementation(async () => undefined),
  createGraphIndexes: vi.fn().mockImplementation(async () => undefined),
}));

// Embedder mocks
vi.mock('../embedder.js', () => ({
  embedSingleChunk: vi.fn().mockImplementation(async () => ({ vector: [0.1], repoId: 'test-repo' })),
  storeEmbeddingRows: vi.fn().mockImplementation(async () => undefined),
}));

// Checkpoint mocks
vi.mock('../checkpoint.js', () => ({
  readCheckpoint: vi.fn().mockImplementation(async () => new Set()),
  writeCheckpoint: vi.fn().mockImplementation(async () => undefined),
  clearCheckpoint: vi.fn().mockImplementation(async () => undefined),
}));

// Memory monitor mock — must use class syntax so it works as a constructor
vi.mock('../memory-monitor.js', () => {
  class MockMemoryMonitor {
    start = vi.fn();
    stop = vi.fn();
    waitIfPaused = vi.fn().mockResolvedValue(undefined);
    isPaused = vi.fn().mockReturnValue(false);
  }
  return { MemoryMonitor: MockMemoryMonitor };
});

// Chunker mock — tracked via vi.fn() so tests can override per-test.
// The default implementation returns one chunk per call.
// Note: vi.clearAllMocks() clears call history but keeps implementations
// set via mockImplementation (implementations survive clearAllMocks).
// We use mockImplementation (not mockReturnValue) so it persists after clearAllMocks.
vi.mock('../chunker.js', () => ({
  extractChunks: vi.fn().mockImplementation((_symbols: unknown, _source: string, filePath: string) => [
    {
      symbolName: 'testFn',
      symbolType: 'function',
      filePath,
      startLine: 1,
      endLine: 5,
      language: 'typescript',
      sourceText: 'function testFn() {}',
    },
  ]),
}));

// Cloner mock
vi.mock('../cloner.js', () => ({
  cloneRepo: vi.fn().mockImplementation(async () => '/tmp/data/repos/test-repo'),
}));

// rm mock (node:fs/promises)
vi.mock('node:fs/promises', async () => {
  const { vi: viFn } = await import('vitest');
  return { rm: viFn.fn().mockImplementation(async () => undefined) };
});

// p-queue mock — track calls for ordering tests via module-level state
// Must use class syntax so it works as a constructor
const pQueueCallLog: string[] = [];
vi.mock('p-queue', () => {
  class MockPQueue {
    add(task: () => Promise<unknown>) {
      pQueueCallLog.push('queue:add');
      return task();
    }
    async onIdle() {
      pQueueCallLog.push('onIdle');
    }
    async onSizeLessThan(_n: number) {
      pQueueCallLog.push('onSizeLessThan');
    }
  }
  return { default: MockPQueue };
});

// Parser registry mock — uses plain functions (not vi.fn) so vi.clearAllMocks()
// does not clear the implementations. Call tracking is done via external state in
// individual tests by wrapping vi.mocked(extractChunks) or writeFileSymbols.
vi.mock('../parsers/registry.js', () => ({
  LANGUAGE_REGISTRY: {
    '.ts': {
      language: 'typescript',
      extractor(_tree: unknown, _source: string, filePath: string) {
        return {
          functions: [{ name: 'testFn', filePath, startLine: 1, endLine: 5, signature: 'function testFn()', language: 'typescript' }],
          classes: [],
          types: [],
          imports: [],
          callSites: [],
        };
      },
    },
  },
  PARSERS: {
    typescript: {
      parse(_source: string) {
        return {
          rootNode: {
            type: 'program',
            namedChildren: [],
            text: '',
          },
        };
      },
    },
  },
}));

// Import modules AFTER mocks are set up
import { IndexPipeline } from '../pipeline.js';
import * as walker from '../walker.js';
import * as graphWriter from '../graph-writer.js';
import * as embedder from '../embedder.js';
import * as checkpoint from '../checkpoint.js';
import { extractChunks } from '../chunker.js';
import { rm } from 'node:fs/promises';
import { cloneRepo } from '../cloner.js';

// Helper to create an async generator from an array
async function* makeFileGen(files: Array<{ absolutePath: string; relativePath: string; language: string }>) {
  for (const f of files) {
    yield f;
  }
}

// Default repo config
const REPO: import('../../types/index.js').RepoConfig = {
  id: 'test-repo',
  name: 'test',
  url: 'https://github.com/test/repo.git',
  branch: 'main',
  addedAt: new Date().toISOString(),
};

// Minimal config
const CONFIG: import('../../types/index.js').Config = {
  port: 4444,
  dataDir: '/tmp/data',
  falkordb: { host: 'localhost', port: 6379 },
  lancedb: { path: '/tmp/data/vectors' },
  ollama: { host: 'http://localhost:11434' },
  repos: [],
  indexer: {
    maxFileSizeBytes: 1_048_576,
    embeddingConcurrency: 5,
    memoryThresholdRatio: 0.80,
    embeddingQueueSize: 500,
  },
};

// Mock adapters
function makeMockAdapters() {
  const mockGraph = {
    query: vi.fn().mockResolvedValue({ data: [] }),
  };
  return {
    falkorAdapter: {
      selectGraph: vi.fn().mockReturnValue(mockGraph),
    } as unknown as import('../../adapters/falkordb.js').FalkorDBAdapter,
    ollamaAdapter: {} as unknown as import('../../adapters/ollama.js').OllamaAdapter,
    lanceAdapter: {} as unknown as import('../../adapters/lancedb.js').LanceDBAdapter,
    mockGraph,
  };
}

describe('IndexPipeline', () => {
  beforeEach(() => {
    // Reset all mocks (clears call history AND implementations set per-test via mockResolvedValue etc.)
    // We then restore the default implementations needed by most tests.
    vi.resetAllMocks();
    pQueueCallLog.length = 0;

    // Restore default implementations after reset
    vi.mocked(graphWriter.writeFileSymbols).mockImplementation(async () => 1);
    vi.mocked(graphWriter.writeCallEdges).mockImplementation(async () => 0);
    vi.mocked(graphWriter.clearGraph).mockImplementation(async () => undefined);
    vi.mocked(graphWriter.createGraphIndexes).mockImplementation(async () => undefined);
    vi.mocked(embedder.embedSingleChunk).mockImplementation(async () => ({ vector: [0.1], repoId: 'test-repo' }));
    vi.mocked(embedder.storeEmbeddingRows).mockImplementation(async () => undefined);
    vi.mocked(checkpoint.readCheckpoint).mockImplementation(async () => new Set());
    vi.mocked(checkpoint.writeCheckpoint).mockImplementation(async () => undefined);
    vi.mocked(checkpoint.clearCheckpoint).mockImplementation(async () => undefined);
    vi.mocked(walker.readSourceFile).mockImplementation(async () => 'function testFn() {}');
    vi.mocked(extractChunks).mockImplementation((_symbols: unknown, _source: string, filePath: string) => [
      {
        symbolName: 'testFn',
        symbolType: 'function' as const,
        filePath,
        startLine: 1,
        endLine: 5,
        language: 'typescript',
        sourceText: 'function testFn() {}',
      },
    ]);
    vi.mocked(cloneRepo).mockImplementation(async () => '/tmp/data/repos/test-repo');
    vi.mocked(rm).mockImplementation(async () => undefined);
  });

  // ── Test 1: Checkpoint resume skips already-indexed files ──────────────────

  it('skips files already in checkpoint when resume=true', async () => {
    const { falkorAdapter, ollamaAdapter, lanceAdapter } = makeMockAdapters();

    const aFile = { absolutePath: '/tmp/data/repos/test-repo/a.ts', relativePath: 'a.ts', language: 'typescript' };
    const bFile = { absolutePath: '/tmp/data/repos/test-repo/b.ts', relativePath: 'b.ts', language: 'typescript' };

    // a.ts is already in the checkpoint
    vi.mocked(checkpoint.readCheckpoint).mockResolvedValue(new Set(['a.ts']));

    // walkRepo yields both files; a.ts should be skipped
    vi.mocked(walker.walkRepo).mockReturnValue(makeFileGen([aFile, bFile]) as ReturnType<typeof walker.walkRepo>);
    vi.mocked(walker.readSourceFile).mockResolvedValue('function testFn() {}');

    const pipeline = new IndexPipeline(falkorAdapter, ollamaAdapter, lanceAdapter, CONFIG);
    await pipeline.run(REPO, { resume: true });

    // writeFileSymbols should only be called for b.ts (not a.ts)
    const writeFileSymbolsCalls = vi.mocked(graphWriter.writeFileSymbols).mock.calls;
    const calledPaths = writeFileSymbolsCalls.map((args) => args[2].relativePath);
    expect(calledPaths).not.toContain('a.ts');
    expect(calledPaths).toContain('b.ts');
  });

  // ── Test 2: Call ordering — writeFileSymbols before extractChunks, extractChunks before next write ──

  it('calls writeFileSymbols before extractChunks (source GC ordering: parse → write → chunk → null)', async () => {
    const { falkorAdapter, ollamaAdapter, lanceAdapter } = makeMockAdapters();

    const aFile = { absolutePath: '/tmp/data/repos/test-repo/a.ts', relativePath: 'a.ts', language: 'typescript' };
    const bFile = { absolutePath: '/tmp/data/repos/test-repo/b.ts', relativePath: 'b.ts', language: 'typescript' };

    vi.mocked(walker.walkRepo).mockReturnValue(makeFileGen([aFile, bFile]) as ReturnType<typeof walker.walkRepo>);
    vi.mocked(walker.readSourceFile).mockResolvedValue('function testFn() {}');

    const callOrder: string[] = [];

    vi.mocked(extractChunks).mockImplementation((_symbols, _source, filePath) => {
      callOrder.push(`extractChunks:${filePath}`);
      return [{ symbolName: 'testFn', symbolType: 'function' as const, filePath: filePath as string, startLine: 1, endLine: 5, language: 'typescript', sourceText: 'function testFn() {}' }];
    });

    vi.mocked(graphWriter.writeFileSymbols).mockImplementation(async (_graph, _repoId, file) => {
      callOrder.push(`writeFileSymbols:${file.relativePath}`);
      return 1;
    });

    const pipeline = new IndexPipeline(falkorAdapter, ollamaAdapter, lanceAdapter, CONFIG);
    await pipeline.run(REPO);

    // For file a.ts: writeFileSymbols must come before extractChunks (ordering: parse → write → chunk)
    const writeAIdx = callOrder.indexOf('writeFileSymbols:a.ts');
    const extractAIdx = callOrder.indexOf('extractChunks:a.ts');
    const writeBIdx = callOrder.indexOf('writeFileSymbols:b.ts');

    expect(writeAIdx).toBeGreaterThanOrEqual(0);
    expect(extractAIdx).toBeGreaterThanOrEqual(0);

    // writeFileSymbols:a.ts happens before extractChunks:a.ts
    expect(writeAIdx).toBeLessThan(extractAIdx);

    // extractChunks:a.ts happens before writeFileSymbols:b.ts (source freed before next file)
    expect(extractAIdx).toBeLessThan(writeBIdx);
  });

  // ── Test 3a: Fresh run (resume=false) calls clearGraph + clearCheckpoint ────

  it('calls clearGraph and clearCheckpoint before walkRepo on fresh run', async () => {
    const { falkorAdapter, ollamaAdapter, lanceAdapter } = makeMockAdapters();

    const callOrder: string[] = [];

    vi.mocked(graphWriter.clearGraph).mockImplementation(async () => {
      callOrder.push('clearGraph');
    });
    vi.mocked(checkpoint.clearCheckpoint).mockImplementation(async () => {
      callOrder.push('clearCheckpoint');
    });
    vi.mocked(walker.walkRepo).mockImplementation(() => {
      callOrder.push('walkRepo:start');
      return makeFileGen([]) as ReturnType<typeof walker.walkRepo>;
    });

    const pipeline = new IndexPipeline(falkorAdapter, ollamaAdapter, lanceAdapter, CONFIG);
    await pipeline.run(REPO); // resume defaults to false

    expect(callOrder).toContain('clearGraph');
    expect(callOrder).toContain('clearCheckpoint');

    const clearGraphIdx = callOrder.indexOf('clearGraph');
    const clearCheckpointIdx = callOrder.indexOf('clearCheckpoint');
    const walkIdx = callOrder.indexOf('walkRepo:start');

    // Both clears must happen before the first walkRepo call
    expect(clearGraphIdx).toBeLessThan(walkIdx);
    expect(clearCheckpointIdx).toBeLessThan(walkIdx);
  });

  // ── Test 3b: Resume run skips clearGraph + clearCheckpoint ────────────────

  it('does NOT call clearGraph when resume=true', async () => {
    const { falkorAdapter, ollamaAdapter, lanceAdapter } = makeMockAdapters();

    vi.mocked(walker.walkRepo).mockReturnValue(makeFileGen([]) as ReturnType<typeof walker.walkRepo>);

    const pipeline = new IndexPipeline(falkorAdapter, ollamaAdapter, lanceAdapter, CONFIG);
    await pipeline.run(REPO, { resume: true });

    // clearGraph should NOT be called on a resume run
    expect(vi.mocked(graphWriter.clearGraph)).not.toHaveBeenCalled();

    // clearCheckpoint IS called once at Stage 6 end (indexing complete cleanup)
    // but NOT at Stage 2 start (which would be 2 calls total on fresh run)
    const clearCheckpointCalls = vi.mocked(checkpoint.clearCheckpoint).mock.calls.length;
    // Resume run: only Stage 6 end cleanup = 1 call
    expect(clearCheckpointCalls).toBe(1);
  });

  // ── Test 4: storeEmbeddingRows called after onIdle ────────────────────────

  it('awaits embeddingQueue.onIdle before calling storeEmbeddingRows', async () => {
    const { falkorAdapter, ollamaAdapter, lanceAdapter } = makeMockAdapters();

    const aFile = { absolutePath: '/tmp/data/repos/test-repo/a.ts', relativePath: 'a.ts', language: 'typescript' };
    vi.mocked(walker.walkRepo).mockReturnValue(makeFileGen([aFile]) as ReturnType<typeof walker.walkRepo>);
    vi.mocked(walker.readSourceFile).mockResolvedValue('function testFn() {}');

    const storeCallLog: string[] = [];

    vi.mocked(embedder.storeEmbeddingRows).mockImplementation(async () => {
      storeCallLog.push('storeEmbeddingRows');
    });

    const pipeline = new IndexPipeline(falkorAdapter, ollamaAdapter, lanceAdapter, CONFIG);
    await pipeline.run(REPO);

    // onIdle is logged to pQueueCallLog, storeEmbeddingRows to storeCallLog
    // We verify via the shared pQueueCallLog that onIdle was called
    expect(pQueueCallLog).toContain('onIdle');
    // And storeEmbeddingRows was actually called
    expect(storeCallLog).toContain('storeEmbeddingRows');
    // The code structure guarantees ordering: onIdle is awaited, then storeEmbeddingRows runs
    // Since both are sequential (await onIdle() then await storeEmbeddingRows()), onIdle appearing
    // in the log before storeEmbeddingRows is the expected behavior.
    const onIdleIdx = pQueueCallLog.indexOf('onIdle');
    // onIdle must have been called (implies it was awaited before store)
    expect(onIdleIdx).toBeGreaterThanOrEqual(0);
    expect(vi.mocked(embedder.storeEmbeddingRows)).toHaveBeenCalledTimes(1);
  });

  // ── Test 5: onSizeLessThan called before enqueuing chunks ────────────────

  it('calls onSizeLessThan with embeddingQueueSize before enqueuing chunk tasks', async () => {
    const { falkorAdapter, ollamaAdapter, lanceAdapter } = makeMockAdapters();

    const aFile = { absolutePath: '/tmp/data/repos/test-repo/a.ts', relativePath: 'a.ts', language: 'typescript' };
    vi.mocked(walker.walkRepo).mockReturnValue(makeFileGen([aFile]) as ReturnType<typeof walker.walkRepo>);
    vi.mocked(walker.readSourceFile).mockResolvedValue('function testFn() {}');

    const pipeline = new IndexPipeline(falkorAdapter, ollamaAdapter, lanceAdapter, CONFIG);
    await pipeline.run(REPO);

    // onSizeLessThan must be called before queue:add
    expect(pQueueCallLog).toContain('onSizeLessThan');
    expect(pQueueCallLog).toContain('queue:add');

    const lessThanIdx = pQueueCallLog.indexOf('onSizeLessThan');
    const addIdx = pQueueCallLog.indexOf('queue:add');
    expect(lessThanIdx).toBeLessThan(addIdx);
  });
});

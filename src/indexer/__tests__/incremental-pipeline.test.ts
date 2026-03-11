/**
 * Integration tests for IndexPipeline incremental mode (Phase 5, Plan 1).
 *
 * All external dependencies are mocked. Tests verify:
 * - incremental: true calls pullRepo instead of cloneRepo
 * - incremental with no lastCommit falls back to full index
 * - incremental with same HEAD as lastCommit returns early (no work done)
 *
 * NOTE: Split from incremental.test.ts because Vitest hoists vi.mock() calls —
 * mocking checkpoint.js/cloner.js here would intercept the real imports used
 * in the unit test file if they were in the same file.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock simple-git ───────────────────────────────────────────────────────────
vi.mock('simple-git', () => ({
  simpleGit: vi.fn(() => ({
    pull: vi.fn(),
    revparse: vi.fn().mockResolvedValue('newsha\n'),
    raw: vi.fn().mockResolvedValue(''),
  })),
}));

// ── Mock all pipeline dependencies ───────────────────────────────────────────
vi.mock('../walker.js', () => ({
  walkRepo: vi.fn(),
  readSourceFile: vi.fn(),
}));

vi.mock('../graph-writer.js', () => ({
  writeFileSymbols: vi.fn().mockImplementation(async () => 1),
  writeCallEdges: vi.fn().mockImplementation(async () => 0),
  clearGraph: vi.fn().mockImplementation(async () => undefined),
  createGraphIndexes: vi.fn().mockImplementation(async () => undefined),
  clearFileNodes: vi.fn().mockImplementation(async () => undefined),
}));

vi.mock('../embedder.js', () => ({
  embedSingleChunk: vi.fn().mockImplementation(async () => ({ vector: [0.1], repoId: 'test-repo' })),
}));

vi.mock('../checkpoint.js', () => ({
  readCheckpoint: vi.fn().mockImplementation(async () => new Set()),
  writeCheckpoint: vi.fn().mockImplementation(async () => undefined),
  clearCheckpoint: vi.fn().mockImplementation(async () => undefined),
  readLastCommit: vi.fn().mockImplementation(async () => null),
  writeLastCommit: vi.fn().mockImplementation(async () => undefined),
}));

vi.mock('../memory-monitor.js', () => {
  class MockMemoryMonitor {
    start = vi.fn();
    stop = vi.fn();
    waitIfPaused = vi.fn().mockResolvedValue(undefined);
    isPaused = vi.fn().mockReturnValue(false);
  }
  return { MemoryMonitor: MockMemoryMonitor };
});

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

vi.mock('../cloner.js', () => ({
  cloneRepo: vi.fn().mockImplementation(async () => '/tmp/data/repos/test-repo'),
  pullRepo: vi.fn().mockImplementation(async () => undefined),
}));

vi.mock('node:fs/promises', async () => {
  const { vi: viFn } = await import('vitest');
  return {
    rm: viFn.fn().mockImplementation(async () => undefined),
    mkdir: viFn.fn().mockImplementation(async () => undefined),
    access: viFn.fn().mockImplementation(async () => undefined),
  };
});

vi.mock('p-queue', () => {
  class MockPQueue {
    add(task: () => Promise<unknown>) { return task(); }
    async onIdle() {}
    async onSizeLessThan(_n: number) {}
  }
  return { default: MockPQueue };
});

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
        return { rootNode: { type: 'program', namedChildren: [], text: '' } };
      },
    },
  },
}));

// ── Import after mocks ────────────────────────────────────────────────────────
import { IndexPipeline } from '../pipeline.js';
import * as cloner from '../cloner.js';
import * as checkpoint from '../checkpoint.js';
import * as graphWriter from '../graph-writer.js';
import { walkRepo } from '../walker.js';
import { simpleGit } from 'simple-git';

// ── Test fixtures ─────────────────────────────────────────────────────────────

const REPO: import('../../types/index.js').RepoConfig = {
  id: 'test-repo',
  name: 'test',
  url: 'https://github.com/test/repo.git',
  branch: 'main',
  addedAt: new Date().toISOString(),
};

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

function makeMockAdapters() {
  const mockGraph = {
    query: vi.fn().mockResolvedValue({ data: [] }),
  };
  return {
    falkorAdapter: {
      selectGraph: vi.fn().mockReturnValue(mockGraph),
    } as unknown as import('../../adapters/falkordb.js').FalkorDBAdapter,
    ollamaAdapter: {} as unknown as import('../../adapters/ollama.js').OllamaAdapter,
    lanceAdapter: {
      getConnection: vi.fn().mockReturnValue({
        tableNames: vi.fn().mockResolvedValue([]),
      }),
      deleteRows: vi.fn().mockResolvedValue(undefined),
      addRows: vi.fn().mockResolvedValue(undefined),
      createOrOverwriteTable: vi.fn().mockResolvedValue(undefined),
    } as unknown as import('../../adapters/lancedb.js').LanceDBAdapter,
    mockGraph,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('IndexPipeline incremental mode', () => {
  beforeEach(() => {
    vi.resetAllMocks();

    vi.mocked(graphWriter.writeFileSymbols).mockImplementation(async () => 1);
    vi.mocked(graphWriter.writeCallEdges).mockImplementation(async () => 0);
    vi.mocked(graphWriter.clearGraph).mockImplementation(async () => undefined);
    vi.mocked(graphWriter.createGraphIndexes).mockImplementation(async () => undefined);
    vi.mocked(graphWriter.clearFileNodes).mockImplementation(async () => undefined);
    vi.mocked(checkpoint.readCheckpoint).mockImplementation(async () => new Set());
    vi.mocked(checkpoint.writeCheckpoint).mockImplementation(async () => undefined);
    vi.mocked(checkpoint.clearCheckpoint).mockImplementation(async () => undefined);
    vi.mocked(checkpoint.readLastCommit).mockImplementation(async () => null);
    vi.mocked(checkpoint.writeLastCommit).mockImplementation(async () => undefined);
    vi.mocked(cloner.cloneRepo).mockImplementation(async () => '/tmp/data/repos/test-repo');
    vi.mocked(cloner.pullRepo).mockImplementation(async () => undefined);

    vi.mocked(simpleGit).mockReturnValue({
      pull: vi.fn(),
      revparse: vi.fn().mockResolvedValue('newsha\n'),
      raw: vi.fn().mockResolvedValue(''),
    } as unknown as ReturnType<typeof simpleGit>);
  });

  it('incremental run calls pullRepo instead of cloneRepo', async () => {
    const { falkorAdapter, ollamaAdapter, lanceAdapter } = makeMockAdapters();

    vi.mocked(checkpoint.readLastCommit).mockResolvedValue('oldsha');

    const pipeline = new IndexPipeline(falkorAdapter, ollamaAdapter, lanceAdapter, CONFIG);
    await pipeline.run(REPO, { incremental: true });

    expect(vi.mocked(cloner.pullRepo)).toHaveBeenCalled();
    expect(vi.mocked(cloner.cloneRepo)).not.toHaveBeenCalled();
  });

  it('incremental run with no lastCommit falls back to full index', async () => {
    const { falkorAdapter, ollamaAdapter, lanceAdapter } = makeMockAdapters();

    vi.mocked(checkpoint.readLastCommit).mockResolvedValue(null);

    vi.mocked(walkRepo).mockReturnValue(
      (async function* () {})() as ReturnType<typeof walkRepo>,
    );

    const pipeline = new IndexPipeline(falkorAdapter, ollamaAdapter, lanceAdapter, CONFIG);
    await pipeline.run(REPO, { incremental: true });

    // Falls back to full run — cloneRepo is called
    expect(vi.mocked(cloner.cloneRepo)).toHaveBeenCalled();
    expect(vi.mocked(cloner.pullRepo)).not.toHaveBeenCalled();
  });

  it('incremental run with same HEAD as lastCommit returns early (no changes)', async () => {
    const { falkorAdapter, ollamaAdapter, lanceAdapter } = makeMockAdapters();

    const sha = 'abc123';
    vi.mocked(checkpoint.readLastCommit).mockResolvedValue(sha);

    vi.mocked(simpleGit).mockReturnValue({
      pull: vi.fn(),
      revparse: vi.fn().mockResolvedValue(sha + '\n'),
      raw: vi.fn().mockResolvedValue(''),
    } as unknown as ReturnType<typeof simpleGit>);

    const pipeline = new IndexPipeline(falkorAdapter, ollamaAdapter, lanceAdapter, CONFIG);
    const result = await pipeline.run(REPO, { incremental: true });

    expect(result.filesProcessed).toBe(0);
    expect(vi.mocked(graphWriter.clearFileNodes)).not.toHaveBeenCalled();
  });
});

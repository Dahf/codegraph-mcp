/**
 * Tests for incremental re-indexing route behavior (Phase 5, Plan 2).
 *
 * Tests:
 * - ?incremental=true returns 202 Accepted immediately
 * - Debounce: rapid successive requests result in a single pipeline.run() call
 * - Lock: a second trigger while indexing in-progress is dropped (returns 202)
 * - Different repoIds run independently (no shared lock or debounce)
 * - installPostCommitHook is called after a successful pipeline.run()
 *
 * Uses Vitest fake timers for debounce control and vi.mock for all heavy deps.
 *
 * NOTE: vi.mock() factories are hoisted by Vitest and run before all other code.
 * Factories must NOT reference any outer variables. All mock state is accessed via
 * the `__state` property attached to the exported constructor.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../indexer/pipeline.js', () => {
  // Shared state accessible via IndexPipeline.__state after import
  const state: {
    instances: Array<{ run: ReturnType<typeof vi.fn> }>;
    nextRunResult: Promise<unknown> | null;
  } = {
    instances: [],
    nextRunResult: null,
  };

  function IndexPipelineMock(this: { run: ReturnType<typeof vi.fn> }) {
    const runResult = state.nextRunResult ?? Promise.resolve({ repoId: 'test', filesProcessed: 5 });
    state.nextRunResult = null; // consume
    this.run = vi.fn().mockReturnValue(runResult);
    state.instances.push(this);
  }
  (IndexPipelineMock as unknown as { __state: typeof state }).__state = state;
  return { IndexPipeline: IndexPipelineMock };
});

vi.mock('../../indexer/hook-installer.js', () => ({
  installPostCommitHook: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../indexer/progress.js', () => {
  function IndexProgressEmitterMock(this: { on: ReturnType<typeof vi.fn>; emit: ReturnType<typeof vi.fn> }) {
    this.on = vi.fn();
    this.emit = vi.fn();
  }
  return { IndexProgressEmitter: IndexProgressEmitterMock };
});

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { indexRoutes } from '../routes/index.js';
import type { RepoConfig } from '../../types/index.js';
import { installPostCommitHook } from '../../indexer/hook-installer.js';
import { IndexPipeline } from '../../indexer/pipeline.js';

// ── Mock state helpers ────────────────────────────────────────────────────────

type PipelineState = {
  instances: Array<{ run: ReturnType<typeof vi.fn> }>;
  nextRunResult: Promise<unknown> | null;
};

function getPipelineState(): PipelineState {
  return (IndexPipeline as unknown as { __state: PipelineState }).__state;
}

function getPipelineInstances() {
  return getPipelineState().instances;
}

function getLatestRunMock(): ReturnType<typeof vi.fn> {
  const instances = getPipelineInstances();
  const latest = instances[instances.length - 1];
  if (!latest) throw new Error('No IndexPipeline instance created');
  return latest.run;
}

function clearPipelineInstances(): void {
  const state = getPipelineState();
  state.instances.length = 0;
  state.nextRunResult = null;
}

// ── App factory ───────────────────────────────────────────────────────────────

function makeRepo(id: string): RepoConfig {
  return {
    id,
    name: `repo-${id}`,
    url: `https://github.com/test/${id}.git`,
    branch: 'main',
    addedAt: new Date().toISOString(),
  };
}

function makeApp(repos: RepoConfig[] = []) {
  const repoManager = { list: vi.fn().mockReturnValue(repos) };
  const falkorAdapter = { selectGraph: vi.fn().mockReturnValue({}) };
  const ollamaAdapter = {};
  const lanceAdapter = { getConnection: vi.fn().mockReturnValue({ tableNames: vi.fn().mockResolvedValue([]) }) };
  const config = {
    dataDir: '/tmp/test-data',
    indexer: {
      embeddingConcurrency: 5,
      embeddingQueueSize: 50,
      maxFileSizeBytes: 1048576,
      memoryThresholdRatio: 0.8,
    },
  };

  const router = indexRoutes(
    repoManager as never,
    falkorAdapter as never,
    ollamaAdapter as never,
    lanceAdapter as never,
    config as never,
  );

  const app = express();
  app.use(router);
  return app;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /repos/:id/index?incremental=true', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearPipelineInstances();
    vi.mocked(installPostCommitHook).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('returns 202 Accepted immediately for incremental=true', async () => {
    const repo = makeRepo('repo-1');
    const app = makeApp([repo]);

    const res = await request(app)
      .post('/repos/repo-1/index?incremental=true')
      .send();

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: 'queued', repoId: 'repo-1' });
  });

  it('does not call pipeline.run before debounce window expires', async () => {
    const repo = makeRepo('repo-1');
    const app = makeApp([repo]);

    await request(app).post('/repos/repo-1/index?incremental=true').send();

    // No pipeline created yet — still within debounce window
    expect(getPipelineInstances()).toHaveLength(0);
  });

  it('debounce: two rapid requests result in a single pipeline.run() call', async () => {
    const repo = makeRepo('repo-1');
    const app = makeApp([repo]);

    // Send two rapid requests
    await request(app).post('/repos/repo-1/index?incremental=true').send();
    await request(app).post('/repos/repo-1/index?incremental=true').send();

    // Neither has fired yet
    expect(getPipelineInstances()).toHaveLength(0);

    // Advance past debounce window
    await vi.runAllTimersAsync();

    // Only one pipeline constructed + run despite two requests
    expect(getPipelineInstances()).toHaveLength(1);
    const runMock = getLatestRunMock();
    expect(runMock).toHaveBeenCalledTimes(1);
    expect(runMock).toHaveBeenCalledWith(repo, { incremental: true });
  });

  it('debounce: three rapid requests also result in only one pipeline.run()', async () => {
    const repo = makeRepo('repo-1');
    const app = makeApp([repo]);

    await request(app).post('/repos/repo-1/index?incremental=true').send();
    await request(app).post('/repos/repo-1/index?incremental=true').send();
    await request(app).post('/repos/repo-1/index?incremental=true').send();

    await vi.runAllTimersAsync();

    expect(getPipelineInstances()).toHaveLength(1);
  });

  it('lock: a trigger while indexing is in-progress is dropped (still returns 202)', async () => {
    // Pre-configure the first pipeline run to never resolve (simulates long index)
    let resolveRun!: (v: unknown) => void;
    const hangingRun = new Promise((resolve) => { resolveRun = resolve; });
    getPipelineState().nextRunResult = hangingRun;

    const repo = makeRepo('repo-1');
    const app = makeApp([repo]);

    // First trigger — debounce fires, pipeline starts and hangs
    await request(app).post('/repos/repo-1/index?incremental=true').send();
    await vi.runAllTimersAsync(); // fires debounce timer; run() is called and hangs

    // One pipeline started, still in-progress
    expect(getPipelineInstances()).toHaveLength(1);

    // Second trigger — lock should drop it
    const res2 = await request(app).post('/repos/repo-1/index?incremental=true').send();
    expect(res2.status).toBe(202);

    await vi.runAllTimersAsync(); // fires debounce for second trigger — should be dropped

    // Still only one instance — second was dropped by lock
    expect(getPipelineInstances()).toHaveLength(1);

    // Cleanup
    resolveRun({ repoId: 'repo-1', filesProcessed: 0 });
    await vi.runAllTimersAsync();
  });

  it('different repoIds debounce and lock independently', async () => {
    const repo1 = makeRepo('repo-1');
    const repo2 = makeRepo('repo-2');
    const app = makeApp([repo1, repo2]);

    // Trigger both repos
    const res1 = await request(app).post('/repos/repo-1/index?incremental=true').send();
    const res2 = await request(app).post('/repos/repo-2/index?incremental=true').send();

    expect(res1.status).toBe(202);
    expect(res2.status).toBe(202);

    await vi.runAllTimersAsync();

    // Both should have run independently
    expect(getPipelineInstances()).toHaveLength(2);
  });

  it('installPostCommitHook is called with correct destPath and repoId after incremental run', async () => {
    const repo = makeRepo('repo-1');
    const app = makeApp([repo]);

    await request(app).post('/repos/repo-1/index?incremental=true').send();
    await vi.runAllTimersAsync();

    expect(installPostCommitHook).toHaveBeenCalledWith(
      expect.stringContaining('repo-1'),
      'repo-1',
    );
  });
});

describe('POST /repos/:id/index (non-incremental, backward compat)', () => {
  beforeEach(() => {
    clearPipelineInstances();
    vi.mocked(installPostCommitHook).mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns 200 with result for non-incremental index', async () => {
    const repo = makeRepo('repo-1');
    const app = makeApp([repo]);

    const res = await request(app).post('/repos/repo-1/index').send();

    expect(res.status).toBe(200);
    expect(getPipelineInstances()).toHaveLength(1);
    const runMock = getLatestRunMock();
    expect(runMock).toHaveBeenCalledWith(repo, { resume: false });
  });

  it('returns 404 for unknown repo ID', async () => {
    const app = makeApp([]);

    const res = await request(app).post('/repos/unknown-id/index').send();

    expect(res.status).toBe(404);
  });

  it('installPostCommitHook is called after a successful non-incremental index run', async () => {
    const repo = makeRepo('repo-1');
    const app = makeApp([repo]);

    await request(app).post('/repos/repo-1/index').send();

    expect(installPostCommitHook).toHaveBeenCalledWith(
      expect.stringContaining('repo-1'),
      'repo-1',
    );
  });
});

describe('POST /repos/index-all', () => {
  beforeEach(() => {
    clearPipelineInstances();
    vi.mocked(installPostCommitHook).mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('calls installPostCommitHook for each successfully indexed repo', async () => {
    const repo1 = makeRepo('repo-1');
    const repo2 = makeRepo('repo-2');
    const app = makeApp([repo1, repo2]);

    const res = await request(app).post('/repos/index-all').send();

    expect(res.status).toBe(200);
    expect(installPostCommitHook).toHaveBeenCalledTimes(2);
  });
});

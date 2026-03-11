/**
 * Unit tests for incremental indexing helpers (Phase 5, Plan 1).
 *
 * Tests the REAL implementations of:
 * - pullRepo: calls simple-git .pull() on an existing clone
 * - readLastCommit / writeLastCommit: persist and retrieve HEAD SHA from Checkpoint node
 * - clearFileNodes: deletes symbol nodes + File node for a given filePath
 * - clearCheckpoint: preserves lastCommit (SET processedFiles = null, not DELETE)
 * - parseDiffNameStatus: parses git diff --name-status output (pure function)
 *
 * NOTE: Pipeline incremental mode integration tests live in incremental-pipeline.test.ts
 * because Vitest hoists vi.mock() calls — mixing real imports and module mocks in one
 * file causes the real implementations to be replaced by mocks.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Graph } from '@falkordb/graph';

// ── Mock simple-git for pullRepo (must be top-level due to Vitest hoisting) ──
const mockPull = vi.fn().mockResolvedValue(undefined);
vi.mock('simple-git', () => ({
  simpleGit: vi.fn(() => ({
    pull: mockPull,
    revparse: vi.fn().mockResolvedValue('abc123\n'),
    raw: vi.fn().mockResolvedValue(''),
  })),
}));

// ── Import real implementations ───────────────────────────────────────────────
import { pullRepo } from '../cloner.js';
import { readLastCommit, writeLastCommit, clearCheckpoint } from '../checkpoint.js';
import { clearFileNodes } from '../graph-writer.js';
import { parseDiffNameStatus } from '../pipeline.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMockGraph(queryResults: Record<string, unknown[][]> = {}) {
  const queriesReceived: Array<{ query: string; params: Record<string, unknown> }> = [];

  const graph = {
    query: vi.fn(async (query: string, options?: { params?: Record<string, unknown> }) => {
      queriesReceived.push({ query, params: options?.params ?? {} });
      for (const [key, rows] of Object.entries(queryResults)) {
        if (query.includes(key)) {
          return { data: rows };
        }
      }
      return { data: [] };
    }),
    _queriesReceived: queriesReceived,
  };

  return graph as unknown as Graph & { _queriesReceived: typeof queriesReceived };
}

// ── pullRepo ──────────────────────────────────────────────────────────────────

describe('pullRepo', () => {
  beforeEach(() => {
    mockPull.mockClear();
  });

  it('calls simple-git pull on the given directory', async () => {
    await pullRepo('/some/repo/path');
    expect(mockPull).toHaveBeenCalled();
  });
});

// ── readLastCommit ────────────────────────────────────────────────────────────

describe('readLastCommit', () => {
  it('returns null when no Checkpoint node exists', async () => {
    const graph = makeMockGraph();
    const result = await readLastCommit(graph, 'repo-1');
    expect(result).toBeNull();
  });

  it('returns the stored SHA string when Checkpoint has lastCommit property', async () => {
    const sha = 'abc123def456';
    const graph = makeMockGraph({
      'c.lastCommit': [{ 'c.lastCommit': sha } as unknown as unknown[]],
    });
    const result = await readLastCommit(graph, 'repo-1');
    expect(result).toBe(sha);
  });

  it('passes repoId as query parameter', async () => {
    const graph = makeMockGraph();
    await readLastCommit(graph, 'my-repo');
    expect(graph.query).toHaveBeenCalledOnce();
    const call = (graph.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1]?.params?.repoId).toBe('my-repo');
  });
});

// ── writeLastCommit ───────────────────────────────────────────────────────────

describe('writeLastCommit', () => {
  it('uses MERGE pattern (not INSERT) to upsert lastCommit', async () => {
    const graph = makeMockGraph();
    await writeLastCommit(graph, 'repo-1', 'deadbeef');
    expect(graph.query).toHaveBeenCalledOnce();
    const call = (graph.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toMatch(/MERGE/i);
  });

  it('passes sha and repoId as query parameters', async () => {
    const graph = makeMockGraph();
    await writeLastCommit(graph, 'repo-1', 'cafebabe');
    const call = (graph.query as ReturnType<typeof vi.fn>).mock.calls[0];
    const params = call[1]?.params as Record<string, unknown>;
    expect(params['sha']).toBe('cafebabe');
    expect(params['repoId']).toBe('repo-1');
  });

  it('includes a timestamp in the query params', async () => {
    const graph = makeMockGraph();
    const before = Date.now();
    await writeLastCommit(graph, 'repo-1', 'abc');
    const after = Date.now();
    const call = (graph.query as ReturnType<typeof vi.fn>).mock.calls[0];
    const params = call[1]?.params as Record<string, unknown>;
    expect(typeof params['ts']).toBe('number');
    expect(params['ts'] as number).toBeGreaterThanOrEqual(before);
    expect(params['ts'] as number).toBeLessThanOrEqual(after);
  });
});

// ── clearCheckpoint - lastCommit preservation ─────────────────────────────────

describe('clearCheckpoint - lastCommit preservation', () => {
  it('uses SET (not DELETE) so lastCommit is preserved', async () => {
    const graph = makeMockGraph();
    await clearCheckpoint(graph, 'repo-1');
    expect(graph.query).toHaveBeenCalledOnce();
    const call = (graph.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toMatch(/SET/i);
    expect(call[0]).not.toMatch(/\bDELETE\b/);
  });

  it('passes repoId as a query parameter', async () => {
    const graph = makeMockGraph();
    await clearCheckpoint(graph, 'my-repo');
    expect(graph.query).toHaveBeenCalledOnce();
    const call = (graph.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1]?.params?.repoId).toBe('my-repo');
  });
});

// ── clearFileNodes ────────────────────────────────────────────────────────────

describe('clearFileNodes', () => {
  it('issues two queries — one for symbol nodes (filePath) and one for File node (path)', async () => {
    const graph = makeMockGraph();
    await clearFileNodes(graph, 'repo-1', 'src/foo.ts');
    expect(graph.query).toHaveBeenCalledTimes(2);
  });

  it('first query deletes symbol nodes by filePath property', async () => {
    const graph = makeMockGraph();
    await clearFileNodes(graph, 'repo-1', 'src/foo.ts');
    const firstCall = (graph.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(firstCall[0]).toMatch(/filePath/);
    expect(firstCall[0]).toMatch(/DETACH DELETE/i);
    expect(firstCall[1]?.params?.filePath).toBe('src/foo.ts');
    expect(firstCall[1]?.params?.repoId).toBe('repo-1');
  });

  it('second query deletes File node by path property', async () => {
    const graph = makeMockGraph();
    await clearFileNodes(graph, 'repo-1', 'src/foo.ts');
    const secondCall = (graph.query as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(secondCall[0]).toMatch(/File/);
    expect(secondCall[0]).toMatch(/path/);
    expect(secondCall[0]).toMatch(/DETACH DELETE/i);
    expect(secondCall[1]?.params?.filePath).toBe('src/foo.ts');
    expect(secondCall[1]?.params?.repoId).toBe('repo-1');
  });
});

// ── parseDiffNameStatus ───────────────────────────────────────────────────────

describe('parseDiffNameStatus', () => {
  it('parses Added files', () => {
    const raw = 'A\tsrc/new.ts';
    const result = parseDiffNameStatus(raw);
    expect(result).toHaveLength(1);
    expect(result[0]!.status).toBe('A');
    expect(result[0]!.path).toBe('src/new.ts');
  });

  it('parses Modified files', () => {
    const raw = 'M\tsrc/existing.ts';
    const result = parseDiffNameStatus(raw);
    expect(result).toHaveLength(1);
    expect(result[0]!.status).toBe('M');
    expect(result[0]!.path).toBe('src/existing.ts');
  });

  it('parses Deleted files', () => {
    const raw = 'D\tsrc/removed.ts';
    const result = parseDiffNameStatus(raw);
    expect(result).toHaveLength(1);
    expect(result[0]!.status).toBe('D');
    expect(result[0]!.path).toBe('src/removed.ts');
  });

  it('parses Renamed files with oldPath', () => {
    const raw = 'R100\tsrc/old.ts\tsrc/new.ts';
    const result = parseDiffNameStatus(raw);
    expect(result).toHaveLength(1);
    expect(result[0]!.status).toBe('R');
    expect(result[0]!.oldPath).toBe('src/old.ts');
    expect(result[0]!.path).toBe('src/new.ts');
  });

  it('handles multiple files with mixed statuses', () => {
    const raw = [
      'A\tsrc/new.ts',
      'M\tsrc/existing.ts',
      'D\tsrc/removed.ts',
      'R100\tsrc/old.ts\tsrc/new2.ts',
    ].join('\n');
    const result = parseDiffNameStatus(raw);
    expect(result).toHaveLength(4);
    expect(result.map((f) => f.status)).toEqual(['A', 'M', 'D', 'R']);
  });

  it('ignores empty lines', () => {
    const raw = 'A\tsrc/new.ts\n\nM\tsrc/other.ts\n';
    const result = parseDiffNameStatus(raw);
    expect(result).toHaveLength(2);
  });

  it('ignores unknown status codes like C (copy)', () => {
    const raw = 'C100\tsrc/origin.ts\tsrc/copy.ts';
    const result = parseDiffNameStatus(raw);
    expect(result).toHaveLength(0);
  });
});

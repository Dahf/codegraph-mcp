import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readCheckpoint, writeCheckpoint, clearCheckpoint } from '../checkpoint.js';
import type { Graph } from '@falkordb/graph';

// Mock Graph object that tracks queries
function makeMockGraph(queryResults: Record<string, unknown[][]> = {}) {
  const queriesReceived: Array<{ query: string; params: Record<string, unknown> }> = [];

  const graph = {
    query: vi.fn(async (query: string, options?: { params?: Record<string, unknown> }) => {
      queriesReceived.push({ query, params: options?.params ?? {} });

      // Find matching result by checking if any key appears in the query
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

describe('readCheckpoint', () => {
  it('returns empty Set when no checkpoint exists', async () => {
    const graph = makeMockGraph();
    const result = await readCheckpoint(graph, 'repo-1');
    expect(result).toBeInstanceOf(Set);
    expect(result.size).toBe(0);
  });

  it('returns the stored file set when checkpoint exists', async () => {
    const files = ['src/a.ts', 'src/b.ts', 'src/c.ts'];
    const graph = makeMockGraph({
      'MATCH': [{ 'c.processedFiles': JSON.stringify(files) }],
    });
    const result = await readCheckpoint(graph, 'repo-1');
    expect(result).toBeInstanceOf(Set);
    expect(result.size).toBe(3);
    expect(result.has('src/a.ts')).toBe(true);
    expect(result.has('src/b.ts')).toBe(true);
    expect(result.has('src/c.ts')).toBe(true);
  });

  it('passes repoId as query parameter', async () => {
    const graph = makeMockGraph();
    await readCheckpoint(graph, 'my-repo');
    expect(graph.query).toHaveBeenCalledOnce();
    const call = (graph.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1]?.params?.repoId).toBe('my-repo');
  });
});

describe('writeCheckpoint', () => {
  it('uses MERGE query (not INSERT) to upsert the checkpoint', async () => {
    const graph = makeMockGraph();
    const files = new Set(['src/a.ts', 'src/b.ts']);
    await writeCheckpoint(graph, 'repo-1', files);

    expect(graph.query).toHaveBeenCalledOnce();
    const call = (graph.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toMatch(/MERGE/i);
  });

  it('serializes the Set as a JSON string in the files parameter', async () => {
    const graph = makeMockGraph();
    const files = new Set(['src/a.ts', 'src/b.ts']);
    await writeCheckpoint(graph, 'repo-1', files);

    const call = (graph.query as ReturnType<typeof vi.fn>).mock.calls[0];
    const params = call[1]?.params as Record<string, unknown>;
    expect(typeof params['files']).toBe('string');
    const parsed = JSON.parse(params['files'] as string) as string[];
    expect(parsed).toContain('src/a.ts');
    expect(parsed).toContain('src/b.ts');
  });

  it('includes a timestamp in the query params', async () => {
    const graph = makeMockGraph();
    const before = Date.now();
    await writeCheckpoint(graph, 'repo-1', new Set(['src/a.ts']));
    const after = Date.now();

    const call = (graph.query as ReturnType<typeof vi.fn>).mock.calls[0];
    const params = call[1]?.params as Record<string, unknown>;
    expect(typeof params['ts']).toBe('number');
    expect(params['ts'] as number).toBeGreaterThanOrEqual(before);
    expect(params['ts'] as number).toBeLessThanOrEqual(after);
  });

  it('can be read back via readCheckpoint', async () => {
    let stored: string | undefined;

    const graph = {
      query: vi.fn(async (query: string, options?: { params?: Record<string, unknown> }) => {
        if (query.includes('MERGE')) {
          stored = options?.params?.['files'] as string;
          return { data: [] };
        }
        // MATCH query for readCheckpoint
        if (stored) {
          return { data: [{ 'c.processedFiles': stored }] };
        }
        return { data: [] };
      }),
    } as unknown as Graph;

    const files = new Set(['src/index.ts', 'src/utils.ts']);
    await writeCheckpoint(graph, 'repo-1', files);
    const result = await readCheckpoint(graph, 'repo-1');

    expect(result.size).toBe(2);
    expect(result.has('src/index.ts')).toBe(true);
    expect(result.has('src/utils.ts')).toBe(true);
  });
});

describe('clearCheckpoint', () => {
  it('uses DELETE query to remove the checkpoint node', async () => {
    const graph = makeMockGraph();
    await clearCheckpoint(graph, 'repo-1');

    expect(graph.query).toHaveBeenCalledOnce();
    const call = (graph.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toMatch(/DELETE/i);
  });

  it('passes repoId as a query parameter', async () => {
    const graph = makeMockGraph();
    await clearCheckpoint(graph, 'my-repo');

    const call = (graph.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1]?.params?.repoId).toBe('my-repo');
  });

  it('after clear, readCheckpoint returns empty Set', async () => {
    let stored: string | null = JSON.stringify(['src/a.ts']);

    const graph = {
      query: vi.fn(async (query: string, options?: { params?: Record<string, unknown> }) => {
        if (query.includes('DELETE')) {
          stored = null;
          return { data: [] };
        }
        if (stored) {
          return { data: [{ 'c.processedFiles': stored }] };
        }
        return { data: [] };
      }),
    } as unknown as Graph;

    await clearCheckpoint(graph, 'repo-1');
    const result = await readCheckpoint(graph, 'repo-1');
    expect(result.size).toBe(0);
  });
});

describe('Multiple repo independence', () => {
  it('checkpoints for different repos are independent', async () => {
    const checkpoints: Record<string, string> = {};

    const graph = {
      query: vi.fn(async (query: string, options?: { params?: Record<string, unknown> }) => {
        const repoId = options?.params?.['repoId'] as string;
        if (query.includes('MERGE')) {
          checkpoints[repoId] = options?.params?.['files'] as string;
          return { data: [] };
        }
        if (query.includes('MATCH') && checkpoints[repoId]) {
          return { data: [{ 'c.processedFiles': checkpoints[repoId] }] };
        }
        return { data: [] };
      }),
    } as unknown as Graph;

    await writeCheckpoint(graph, 'repo-A', new Set(['a.ts']));
    await writeCheckpoint(graph, 'repo-B', new Set(['b.ts', 'c.ts']));

    const resultA = await readCheckpoint(graph, 'repo-A');
    const resultB = await readCheckpoint(graph, 'repo-B');

    expect(resultA.size).toBe(1);
    expect(resultA.has('a.ts')).toBe(true);
    expect(resultB.size).toBe(2);
    expect(resultB.has('b.ts')).toBe(true);
    expect(resultB.has('c.ts')).toBe(true);
  });
});

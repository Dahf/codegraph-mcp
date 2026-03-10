/**
 * Tests for graph-writer per-file functions.
 * Mocks Graph.query() to verify Cypher query patterns and parameters.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Graph } from '@falkordb/graph';
import type { SourceFile, ExtractedSymbols, CallEdge } from '../../types/index.js';
import {
  clearGraph,
  createGraphIndexes,
  writeFileSymbols,
  writeCallEdges,
  writeGraph,
} from '../graph-writer.js';

// Minimal mock for the Graph object
function makeMockGraph() {
  const calls: Array<{ query: string; params?: unknown }> = [];
  const graph = {
    query: vi.fn(async (q: string, opts?: { params?: unknown }) => {
      calls.push({ query: q, params: opts?.params });
      return { data: [] };
    }),
    _calls: calls,
  };
  return graph as unknown as Graph & { _calls: typeof calls };
}

function makeSourceFile(overrides: Partial<SourceFile> = {}): SourceFile {
  return {
    absolutePath: '/repo/src/foo.ts',
    relativePath: 'src/foo.ts',
    language: 'typescript',
    ...overrides,
  };
}

function makeSymbols(overrides: Partial<ExtractedSymbols> = {}): ExtractedSymbols {
  return {
    functions: [],
    classes: [],
    types: [],
    imports: [],
    callSites: [],
    ...overrides,
  };
}

// ── clearGraph ────────────────────────────────────────────────────────────────

describe('clearGraph', () => {
  it('runs DETACH DELETE query', async () => {
    const graph = makeMockGraph();
    await clearGraph(graph as unknown as Graph);
    expect(graph.query).toHaveBeenCalledTimes(1);
    const q = graph._calls[0]!.query;
    expect(q).toMatch(/DETACH DELETE/i);
  });

  it('accepts optional repoId without error', async () => {
    const graph = makeMockGraph();
    await expect(clearGraph(graph as unknown as Graph, 'my-repo')).resolves.toBeUndefined();
  });
});

// ── createGraphIndexes ────────────────────────────────────────────────────────

describe('createGraphIndexes', () => {
  it('creates exactly 5 indexes', async () => {
    const graph = makeMockGraph();
    await createGraphIndexes(graph as unknown as Graph);
    expect(graph.query).toHaveBeenCalledTimes(5);
  });

  it('creates index on Function.name', async () => {
    const graph = makeMockGraph();
    await createGraphIndexes(graph as unknown as Graph);
    const queries = graph._calls.map((c) => c.query);
    expect(queries.some((q) => q.includes('Function') && q.includes('name'))).toBe(true);
  });

  it('creates index on Function.filePath', async () => {
    const graph = makeMockGraph();
    await createGraphIndexes(graph as unknown as Graph);
    const queries = graph._calls.map((c) => c.query);
    expect(queries.some((q) => q.includes('Function') && q.includes('filePath'))).toBe(true);
  });

  it('creates index on Class.name', async () => {
    const graph = makeMockGraph();
    await createGraphIndexes(graph as unknown as Graph);
    const queries = graph._calls.map((c) => c.query);
    expect(queries.some((q) => q.includes('Class') && q.includes('name'))).toBe(true);
  });

  it('creates index on File.path', async () => {
    const graph = makeMockGraph();
    await createGraphIndexes(graph as unknown as Graph);
    const queries = graph._calls.map((c) => c.query);
    expect(queries.some((q) => q.includes('File') && q.includes('path'))).toBe(true);
  });

  it('creates index on Type.name', async () => {
    const graph = makeMockGraph();
    await createGraphIndexes(graph as unknown as Graph);
    const queries = graph._calls.map((c) => c.query);
    expect(queries.some((q) => q.includes('Type') && q.includes('name'))).toBe(true);
  });
});

// ── writeFileSymbols ──────────────────────────────────────────────────────────

describe('writeFileSymbols', () => {
  it('writes a File node with MERGE', async () => {
    const graph = makeMockGraph();
    const file = makeSourceFile();
    const symbols = makeSymbols();
    await writeFileSymbols(graph as unknown as Graph, 'repo1', file, symbols);
    const queries = graph._calls.map((c) => c.query);
    expect(queries.some((q) => q.includes('MERGE') && q.includes(':File'))).toBe(true);
  });

  it('with empty symbols, produces only a File node (no extra queries)', async () => {
    const graph = makeMockGraph();
    const file = makeSourceFile();
    const symbols = makeSymbols(); // all empty
    await writeFileSymbols(graph as unknown as Graph, 'repo1', file, symbols);
    // Only the File MERGE query
    expect(graph.query).toHaveBeenCalledTimes(1);
  });

  it('writes Function nodes when functions present', async () => {
    const graph = makeMockGraph();
    const file = makeSourceFile();
    const symbols = makeSymbols({
      functions: [
        { name: 'myFn', filePath: 'src/foo.ts', startLine: 1, endLine: 5, signature: 'function myFn()', language: 'typescript' },
      ],
    });
    await writeFileSymbols(graph as unknown as Graph, 'repo1', file, symbols);
    const queries = graph._calls.map((c) => c.query);
    expect(queries.some((q) => q.includes(':Function'))).toBe(true);
  });

  it('writes Class nodes when classes present', async () => {
    const graph = makeMockGraph();
    const file = makeSourceFile();
    const symbols = makeSymbols({
      classes: [
        { name: 'MyClass', filePath: 'src/foo.ts', startLine: 1, endLine: 20, language: 'typescript' },
      ],
    });
    await writeFileSymbols(graph as unknown as Graph, 'repo1', file, symbols);
    const queries = graph._calls.map((c) => c.query);
    expect(queries.some((q) => q.includes(':Class'))).toBe(true);
  });

  it('writes Type nodes when types present', async () => {
    const graph = makeMockGraph();
    const file = makeSourceFile();
    const symbols = makeSymbols({
      types: [
        { name: 'MyType', filePath: 'src/foo.ts', startLine: 1, endLine: 3, language: 'typescript' },
      ],
    });
    await writeFileSymbols(graph as unknown as Graph, 'repo1', file, symbols);
    const queries = graph._calls.map((c) => c.query);
    expect(queries.some((q) => q.includes(':Type'))).toBe(true);
  });

  it('writes Import nodes when imports present', async () => {
    const graph = makeMockGraph();
    const file = makeSourceFile();
    const symbols = makeSymbols({
      imports: [
        { modulePath: './bar', filePath: 'src/foo.ts', symbols: ['bar'] },
      ],
    });
    await writeFileSymbols(graph as unknown as Graph, 'repo1', file, symbols);
    const queries = graph._calls.map((c) => c.query);
    expect(queries.some((q) => q.includes(':Import'))).toBe(true);
  });

  it('writes CONTAINS edges for functions', async () => {
    const graph = makeMockGraph();
    const file = makeSourceFile();
    const symbols = makeSymbols({
      functions: [
        { name: 'myFn', filePath: 'src/foo.ts', startLine: 1, endLine: 5, signature: 'function myFn()', language: 'typescript' },
      ],
    });
    await writeFileSymbols(graph as unknown as Graph, 'repo1', file, symbols);
    const queries = graph._calls.map((c) => c.query);
    expect(queries.some((q) => q.includes('CONTAINS'))).toBe(true);
  });

  it('writes HAS_METHOD edges for method functions', async () => {
    const graph = makeMockGraph();
    const file = makeSourceFile();
    const symbols = makeSymbols({
      classes: [
        { name: 'MyClass', filePath: 'src/foo.ts', startLine: 1, endLine: 20, language: 'typescript' },
      ],
      functions: [
        { name: 'myMethod', filePath: 'src/foo.ts', startLine: 5, endLine: 10, signature: 'myMethod()', language: 'typescript', className: 'MyClass' },
      ],
    });
    await writeFileSymbols(graph as unknown as Graph, 'repo1', file, symbols);
    const queries = graph._calls.map((c) => c.query);
    expect(queries.some((q) => q.includes('HAS_METHOD'))).toBe(true);
  });

  it('returns edge count (CONTAINS + HAS_METHOD)', async () => {
    const graph = makeMockGraph();
    const file = makeSourceFile();
    const symbols = makeSymbols({
      functions: [
        { name: 'myFn', filePath: 'src/foo.ts', startLine: 1, endLine: 5, signature: 'fn()', language: 'typescript' },
      ],
      classes: [
        { name: 'MyClass', filePath: 'src/foo.ts', startLine: 10, endLine: 20, language: 'typescript' },
      ],
    });
    const edges = await writeFileSymbols(graph as unknown as Graph, 'repo1', file, symbols);
    // 1 function CONTAINS + 1 class CONTAINS = 2 (no HAS_METHOD since fn has no className)
    expect(edges).toBe(2);
  });
});

// ── writeCallEdges ────────────────────────────────────────────────────────────

describe('writeCallEdges', () => {
  it('runs CALLS MERGE query with UNWIND', async () => {
    const graph = makeMockGraph();
    const callEdges: CallEdge[] = [
      { callerName: 'a', callerFilePath: 'src/a.ts', calleeName: 'b', calleeFilePath: 'src/b.ts', crossFile: true },
    ];
    await writeCallEdges(graph as unknown as Graph, 'repo1', callEdges);
    const queries = graph._calls.map((c) => c.query);
    expect(queries.some((q) => q.includes('CALLS') && q.includes('UNWIND'))).toBe(true);
  });

  it('returns call edge count', async () => {
    const graph = makeMockGraph();
    const callEdges: CallEdge[] = [
      { callerName: 'a', callerFilePath: 'src/a.ts', calleeName: 'b', calleeFilePath: 'src/b.ts', crossFile: false },
      { callerName: 'b', callerFilePath: 'src/b.ts', calleeName: 'c', calleeFilePath: 'src/c.ts', crossFile: true },
    ];
    const count = await writeCallEdges(graph as unknown as Graph, 'repo1', callEdges);
    expect(count).toBe(2);
  });

  it('does nothing when callEdges array is empty', async () => {
    const graph = makeMockGraph();
    const count = await writeCallEdges(graph as unknown as Graph, 'repo1', []);
    expect(graph.query).not.toHaveBeenCalled();
    expect(count).toBe(0);
  });
});

// ── writeGraph (backward compat) ──────────────────────────────────────────────

describe('writeGraph (backward compat)', () => {
  it('still works end-to-end with mocked adapter', async () => {
    const graph = makeMockGraph();
    const falkorAdapter = {
      selectGraph: vi.fn(() => graph),
    } as unknown as import('../../adapters/falkordb.js').FalkorDBAdapter;

    const result = await writeGraph(
      'repo1',
      [{ file: makeSourceFile(), symbols: makeSymbols() }],
      [],
      falkorAdapter,
    );
    expect(typeof result).toBe('number');
    expect(falkorAdapter.selectGraph).toHaveBeenCalledWith('codegraph-repo1');
  });
});

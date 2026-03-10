/**
 * Tests for embedder per-chunk and storage functions.
 * Mocks OllamaAdapter and LanceDBAdapter to verify behavior.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OllamaAdapter } from '../../adapters/ollama.js';
import type { LanceDBAdapter } from '../../adapters/lancedb.js';
import type { CodeChunk } from '../chunker.js';
import {
  embedSingleChunk,
  storeEmbeddingRows,
  embedAndStore,
} from '../embedder.js';

function makeChunk(overrides: Partial<CodeChunk> = {}): CodeChunk {
  return {
    symbolName: 'myFn',
    symbolType: 'function',
    filePath: 'src/foo.ts',
    startLine: 1,
    endLine: 10,
    language: 'typescript',
    sourceText: 'function myFn() {}',
    ...overrides,
  };
}

function makeMockOllama(embedding: number[] | null = [0.1, 0.2, 0.3]): OllamaAdapter {
  return {
    embed: vi.fn(async () => (embedding ? [embedding] : [])),
  } as unknown as OllamaAdapter;
}

function makeMockLance(tableExists: boolean = true): LanceDBAdapter & {
  _deleteRows: ReturnType<typeof vi.fn>;
  _addRows: ReturnType<typeof vi.fn>;
  _createOrOverwrite: ReturnType<typeof vi.fn>;
  _tableNames: ReturnType<typeof vi.fn>;
} {
  const deleteRows = vi.fn(async () => {});
  const addRows = vi.fn(async () => {});
  const createOrOverwriteTable = vi.fn(async () => ({}));
  const tableNames = vi.fn(async () => (tableExists ? ['embeddings'] : []));

  const adapter = {
    getConnection: vi.fn(() => ({ tableNames })),
    deleteRows,
    addRows,
    createOrOverwriteTable,
    _deleteRows: deleteRows,
    _addRows: addRows,
    _createOrOverwrite: createOrOverwriteTable,
    _tableNames: tableNames,
  };
  return adapter as unknown as ReturnType<typeof makeMockLance>;
}

// ── embedSingleChunk ──────────────────────────────────────────────────────────

describe('embedSingleChunk', () => {
  it('returns a row object with expected fields on success', async () => {
    const chunk = makeChunk();
    const ollama = makeMockOllama([0.1, 0.2, 0.3]);
    const result = await embedSingleChunk(chunk, 'repo1', ollama, 'mymodel');
    expect(result).not.toBeNull();
    expect(result).toMatchObject({
      repoId: 'repo1',
      filePath: 'src/foo.ts',
      symbolName: 'myFn',
      symbolType: 'function',
      startLine: 1,
      endLine: 10,
      language: 'typescript',
      sourceText: 'function myFn() {}',
      vector: [0.1, 0.2, 0.3],
    });
  });

  it('calls ollamaAdapter.embed() with the chunk sourceText and model', async () => {
    const chunk = makeChunk({ sourceText: 'hello world' });
    const ollama = makeMockOllama();
    await embedSingleChunk(chunk, 'repo1', ollama, 'code-embed');
    expect(ollama.embed).toHaveBeenCalledWith('hello world', 'code-embed');
  });

  it('returns null on Ollama error without throwing', async () => {
    const chunk = makeChunk();
    const ollama = {
      embed: vi.fn(async () => { throw new Error('Ollama connection refused'); }),
    } as unknown as OllamaAdapter;
    const result = await embedSingleChunk(chunk, 'repo1', ollama, 'mymodel');
    expect(result).toBeNull();
  });

  it('returns null when Ollama returns empty embedding array', async () => {
    const chunk = makeChunk();
    const ollama = makeMockOllama(null); // returns []
    const result = await embedSingleChunk(chunk, 'repo1', ollama, 'mymodel');
    expect(result).toBeNull();
  });
});

// ── storeEmbeddingRows ────────────────────────────────────────────────────────

describe('storeEmbeddingRows', () => {
  it('calls deleteRows then addRows when table exists', async () => {
    const lance = makeMockLance(true);
    const rows = [{ vector: [1, 2], repoId: 'repo1', filePath: 'a.ts', symbolName: 'fn', symbolType: 'function', startLine: 1, endLine: 5, language: 'typescript', sourceText: 'fn()' }];
    await storeEmbeddingRows(rows, 'repo1', lance as unknown as LanceDBAdapter);
    expect(lance._deleteRows).toHaveBeenCalledTimes(1);
    expect(lance._addRows).toHaveBeenCalledWith('embeddings', rows);
    expect(lance._createOrOverwrite).not.toHaveBeenCalled();
  });

  it('calls createOrOverwriteTable when table does not exist', async () => {
    const lance = makeMockLance(false);
    const rows = [{ vector: [1, 2], repoId: 'repo1', filePath: 'a.ts', symbolName: 'fn', symbolType: 'function', startLine: 1, endLine: 5, language: 'typescript', sourceText: 'fn()' }];
    await storeEmbeddingRows(rows, 'repo1', lance as unknown as LanceDBAdapter);
    expect(lance._createOrOverwrite).toHaveBeenCalledWith('embeddings', rows);
    expect(lance._deleteRows).not.toHaveBeenCalled();
    expect(lance._addRows).not.toHaveBeenCalled();
  });

  it('does nothing when rows array is empty', async () => {
    const lance = makeMockLance(true);
    await storeEmbeddingRows([], 'repo1', lance as unknown as LanceDBAdapter);
    expect(lance._deleteRows).not.toHaveBeenCalled();
    expect(lance._addRows).not.toHaveBeenCalled();
    expect(lance._createOrOverwrite).not.toHaveBeenCalled();
  });
});

// ── embedAndStore (backward compat) ──────────────────────────────────────────

describe('embedAndStore (backward compat)', () => {
  it('returns stored/failed counts for successful batch', async () => {
    const chunks = [makeChunk({ symbolName: 'fn1' }), makeChunk({ symbolName: 'fn2' })];
    const ollama = makeMockOllama([0.1, 0.2]);
    const lance = makeMockLance(false);
    const result = await embedAndStore(chunks, 'repo1', ollama, lance as unknown as LanceDBAdapter, { model: 'mymodel', concurrency: 2 });
    expect(result).toMatchObject({ stored: 2, failed: 0 });
  });

  it('handles partial failures gracefully', async () => {
    const chunks = [makeChunk({ symbolName: 'fn1' }), makeChunk({ symbolName: 'fn2' })];
    let callCount = 0;
    const ollama = {
      embed: vi.fn(async () => {
        callCount++;
        if (callCount === 1) throw new Error('fail');
        return [[0.1, 0.2]];
      }),
    } as unknown as OllamaAdapter;
    const lance = makeMockLance(false);
    const result = await embedAndStore(chunks, 'repo1', ollama, lance as unknown as LanceDBAdapter, { model: 'mymodel', concurrency: 2 });
    expect(result.stored).toBe(1);
    expect(result.failed).toBe(1);
  });
});

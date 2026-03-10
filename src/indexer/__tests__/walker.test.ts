import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// Mock the LANGUAGE_REGISTRY so tests don't need tree-sitter grammars at runtime
vi.mock('../parsers/registry.js', () => ({
  LANGUAGE_REGISTRY: {
    '.ts': { language: 'typescript' },
    '.py': { language: 'python' },
    '.js': { language: 'javascript' },
  },
}));

// Import walker AFTER mocking registry
const { walkRepo, readSourceFile } = await import('../walker.js');

describe('walkRepo (async generator)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'walker-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('should be an async generator (AsyncGenerator)', async () => {
    const gen = walkRepo(tmpDir);
    expect(gen[Symbol.asyncIterator]).toBeDefined();
    expect(typeof gen.next).toBe('function');
  });

  it('should yield SourceFile objects with correct fields', async () => {
    await writeFile(path.join(tmpDir, 'index.ts'), 'const x = 1;');
    await writeFile(path.join(tmpDir, 'app.py'), 'print("hello")');

    const results = [];
    for await (const file of walkRepo(tmpDir)) {
      results.push(file);
    }

    expect(results).toHaveLength(2);
    const tsFile = results.find(f => f.relativePath === 'index.ts');
    expect(tsFile).toBeDefined();
    expect(tsFile!.absolutePath).toBe(path.join(tmpDir, 'index.ts'));
    expect(tsFile!.language).toBe('typescript');

    const pyFile = results.find(f => f.relativePath === 'app.py');
    expect(pyFile).toBeDefined();
    expect(pyFile!.language).toBe('python');
  });

  it('should skip files larger than maxFileSizeBytes', async () => {
    // Write a small file (7 bytes — below threshold of 50)
    await writeFile(path.join(tmpDir, 'small.ts'), 'x = 1;');
    // Write a large file (should be skipped if maxFileSizeBytes=50)
    await writeFile(path.join(tmpDir, 'large.ts'), 'const bigFile = "this is definitely larger than fifty bytes total here";');

    const results = [];
    for await (const file of walkRepo(tmpDir, { maxFileSizeBytes: 50 })) {
      results.push(file);
    }

    // Only small.ts should be yielded
    expect(results).toHaveLength(1);
    expect(results[0]!.relativePath).toBe('small.ts');
  });

  it('should yield all files when maxFileSizeBytes is not set', async () => {
    await writeFile(path.join(tmpDir, 'file1.ts'), 'const x = 1;');
    await writeFile(path.join(tmpDir, 'file2.ts'), 'const y = 2;');

    const results = [];
    for await (const file of walkRepo(tmpDir)) {
      results.push(file);
    }

    expect(results).toHaveLength(2);
  });

  it('should skip NOISE_DIRS (node_modules, .git, dist, etc.)', async () => {
    await writeFile(path.join(tmpDir, 'src.ts'), 'const x = 1;');
    // Create noise directories with source files
    await mkdir(path.join(tmpDir, 'node_modules'));
    await writeFile(path.join(tmpDir, 'node_modules', 'dep.ts'), 'const dep = 1;');
    await mkdir(path.join(tmpDir, '.git'));
    await writeFile(path.join(tmpDir, '.git', 'config.ts'), 'const config = 1;');

    const results = [];
    for await (const file of walkRepo(tmpDir)) {
      results.push(file);
    }

    expect(results).toHaveLength(1);
    expect(results[0]!.relativePath).toBe('src.ts');
  });

  it('should skip NOISE_SUFFIXES (.min.js, .d.ts)', async () => {
    await writeFile(path.join(tmpDir, 'app.ts'), 'const x = 1;');
    await writeFile(path.join(tmpDir, 'bundle.min.js'), 'var x=1;');
    await writeFile(path.join(tmpDir, 'types.d.ts'), 'declare const x: number;');

    const results = [];
    for await (const file of walkRepo(tmpDir)) {
      results.push(file);
    }

    expect(results).toHaveLength(1);
    expect(results[0]!.relativePath).toBe('app.ts');
  });

  it('should skip files with non-language extensions', async () => {
    await writeFile(path.join(tmpDir, 'app.ts'), 'const x = 1;');
    await writeFile(path.join(tmpDir, 'README.md'), '# Hello');
    await writeFile(path.join(tmpDir, 'config.json'), '{}');

    const results = [];
    for await (const file of walkRepo(tmpDir)) {
      results.push(file);
    }

    expect(results).toHaveLength(1);
    expect(results[0]!.relativePath).toBe('app.ts');
  });
});

describe('readSourceFile', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'walker-read-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('should return file contents as string', async () => {
    const filePath = path.join(tmpDir, 'test.ts');
    await writeFile(filePath, 'const x = 1;', 'utf-8');
    const result = await readSourceFile(filePath);
    expect(result).toBe('const x = 1;');
  });

  it('should return null for non-existent file', async () => {
    const result = await readSourceFile(path.join(tmpDir, 'nonexistent.ts'));
    expect(result).toBeNull();
  });
});

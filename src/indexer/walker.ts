import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { SourceFile } from '../types/index.js';
import { LANGUAGE_REGISTRY } from './parsers/registry.js';

/** Directory segments that indicate noise — skip entire subtree */
const NOISE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build',
  'target', 'vendor', '__pycache__',
]);

/** File suffixes that indicate noise — skip the file */
const NOISE_SUFFIXES = ['.min.js', '.d.ts'];

/**
 * Recursively walk repoRoot and return all source files whose extension
 * appears in LANGUAGE_REGISTRY, excluding noise paths.
 */
export async function walkRepo(repoRoot: string): Promise<SourceFile[]> {
  const results: SourceFile[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (NOISE_DIRS.has(entry.name)) continue;
        await walk(fullPath);
        continue;
      }

      if (!entry.isFile()) continue;

      // Skip noise file suffixes
      if (NOISE_SUFFIXES.some(suffix => entry.name.endsWith(suffix))) continue;

      const ext = path.extname(entry.name).toLowerCase();
      const langConfig = LANGUAGE_REGISTRY[ext];
      if (!langConfig) continue;

      results.push({
        absolutePath: fullPath,
        relativePath: path.relative(repoRoot, fullPath),
        language: langConfig.language,
      });
    }
  }

  await walk(repoRoot);
  return results;
}

/**
 * Read file content as UTF-8 string.
 * Returns null and logs if the file is not valid UTF-8 or cannot be read.
 */
export async function readSourceFile(absolutePath: string): Promise<string | null> {
  try {
    return await readFile(absolutePath, 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[walker] Cannot read file ${absolutePath}: ${msg}`);
    return null;
  }
}

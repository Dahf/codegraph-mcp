import path from 'node:path';
import { rm } from 'node:fs/promises';
import type { FalkorDBAdapter } from '../adapters/falkordb.js';
import type { Config, RepoConfig, IndexResult, ExtractedSymbols, SourceFile } from '../types/index.js';
import { cloneRepo } from './cloner.js';
import { walkRepo, readSourceFile } from './walker.js';
import { LANGUAGE_REGISTRY, PARSERS } from './parsers/registry.js';

/**
 * IndexPipeline orchestrates the four stages of indexing a single repository:
 *   1. clone  — git clone to local disk
 *   2. walk   — discover source files
 *   3. parse  — extract symbols from each file
 *   4. write  — upsert symbols and edges into FalkorDB
 *
 * One pipeline instance per index request. Cloned repo is always removed in finally.
 */
export class IndexPipeline {
  constructor(
    private readonly falkorAdapter: FalkorDBAdapter,
    private readonly config: Config,
  ) {}

  async run(repo: RepoConfig): Promise<IndexResult> {
    const destPath = path.join(this.config.dataDir, 'repos', repo.id);
    const result: IndexResult = {
      repoId: repo.id,
      filesProcessed: 0,
      symbolsExtracted: 0,
      edgesCreated: 0,
      failedFiles: [],
    };

    try {
      // Stage 1: Clone
      await cloneRepo(repo.url, repo.branch, repo.id, this.config.dataDir);

      // Stage 2: Walk
      const files = await walkRepo(destPath);

      // Stage 3: Parse — collect all symbols for two-pass call resolution
      const allSymbols: Array<{ file: SourceFile; symbols: ExtractedSymbols }> = [];
      for (const file of files) {
        try {
          const source = await readSourceFile(file.absolutePath);
          if (source === null) {
            result.failedFiles.push({ path: file.relativePath, error: 'Could not read file' });
            continue;
          }

          const langConfig = LANGUAGE_REGISTRY[path.extname(file.absolutePath).toLowerCase()];
          if (!langConfig) continue;

          const parser = PARSERS[langConfig.language];
          const tree = parser.parse(source);
          const symbols = langConfig.extractor(tree, source, file.relativePath);

          allSymbols.push({ file, symbols });
          result.symbolsExtracted +=
            symbols.functions.length + symbols.classes.length +
            symbols.types.length + symbols.imports.length;
          result.filesProcessed++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[pipeline] Parse error: ${file.relativePath}: ${msg}`);
          result.failedFiles.push({ path: file.relativePath, error: msg });
        }
      }

      // Stage 4: Write to FalkorDB — implemented in plan 02-04
      // For now this is a stub that will be replaced when graph-writer.ts is added
      // The write stage calls writeGraph(repo.id, allSymbols, this.falkorAdapter)
      void allSymbols; // suppress unused-variable warning until 02-04 implements write stage

    } finally {
      // Always clean up — disk usage grows unbounded otherwise
      await rm(destPath, { recursive: true, force: true }).catch(() => {});
    }

    return result;
  }
}

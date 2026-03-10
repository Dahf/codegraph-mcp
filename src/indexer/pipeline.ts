import path from 'node:path';
import { rm } from 'node:fs/promises';
import PQueue from 'p-queue';
import type Parser from 'tree-sitter';
import type { FalkorDBAdapter } from '../adapters/falkordb.js';
import type { OllamaAdapter } from '../adapters/ollama.js';
import type { LanceDBAdapter } from '../adapters/lancedb.js';
import type {
  Config,
  RepoConfig,
  IndexResult,
} from '../types/index.js';
import { cloneRepo } from './cloner.js';
import { walkRepo, readSourceFile } from './walker.js';
import { LANGUAGE_REGISTRY, PARSERS } from './parsers/registry.js';
import { writeFileSymbols, writeCallEdges, clearGraph, createGraphIndexes } from './graph-writer.js';
import { extractChunks } from './chunker.js';
import { embedSingleChunk } from './embedder.js';
import { readCheckpoint, writeCheckpoint, clearCheckpoint } from './checkpoint.js';
import { MemoryMonitor } from './memory-monitor.js';
import type { IndexProgressEmitter } from './progress.js';
import { EMBED_MODEL } from '../constants.js';

/**
 * Walk all nodes of a tree and collect call_expression callee names.
 *
 * This uses a generic approach that works across TypeScript, JavaScript,
 * Python, Rust, Go, and C++ — all TreeSitter grammars name function calls
 * "call_expression". The identifier/function child text is extracted as the
 * callee name.
 *
 * Returns an array of raw callee name strings found in the file.
 */
function extractCallSiteNames(node: Parser.SyntaxNode): string[] {
  const names: string[] = [];

  function walk(n: Parser.SyntaxNode): void {
    if (n.type === 'call_expression') {
      // First named child is typically the function being called.
      // For `foo()` → identifier text = 'foo'
      // For `obj.foo()` → member_expression — we only want the last identifier
      // For `new Foo()` → constructor call; skip (not a regular call)
      const callee = n.namedChildren[0];
      if (callee) {
        let calleeName: string | undefined;
        if (callee.type === 'identifier') {
          calleeName = callee.text;
        } else if (callee.type === 'member_expression' || callee.type === 'field_expression') {
          // For chained calls like `obj.foo()`, extract the property name
          const prop = callee.namedChildren[callee.namedChildren.length - 1];
          if (prop && (prop.type === 'identifier' || prop.type === 'property_identifier')) {
            calleeName = prop.text;
          }
        }
        if (calleeName) {
          names.push(calleeName);
        }
      }
    }
    for (const child of n.namedChildren) {
      walk(child);
    }
  }

  walk(node);
  return names;
}

/**
 * IndexPipeline orchestrates the stages of indexing a single repository using
 * a streaming two-pass architecture that processes one file at a time.
 *
 * Pass 1: Stream files → parse → write symbols to FalkorDB → queue embeddings
 * Pass 2: Stream files again → extract call sites → resolve via FalkorDB → write CALLS edges
 *
 * Memory is bounded via:
 * - Streaming file walker (no full directory listing in memory)
 * - p-queue for concurrent embeddings with backpressure via onSizeLessThan
 * - MemoryMonitor that pauses processing when heap exceeds threshold
 * - Checkpoint-based resume after crashes
 *
 * One pipeline instance per index request. Cloned repo is always removed in finally.
 */
/** Flush embedding rows to LanceDB every N accumulated rows to bound memory. */
const EMBEDDING_FLUSH_SIZE = 200;

/** Write checkpoint every N files instead of every file (reduces JSON serialization pressure). */
const CHECKPOINT_INTERVAL = 50;

export class IndexPipeline {
  constructor(
    private readonly falkorAdapter: FalkorDBAdapter,
    private readonly ollamaAdapter: OllamaAdapter,
    private readonly lanceAdapter: LanceDBAdapter,
    private readonly config: Config,
    private readonly progressEmitter?: IndexProgressEmitter,
  ) {}

  async run(repo: RepoConfig, options?: { resume?: boolean }): Promise<IndexResult> {
    const resume = options?.resume ?? false;
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
      // Clone errors propagate up — the route handler catches and returns HTTP 400/500.
      await cloneRepo(repo.url, repo.branch, repo.id, this.config.dataDir);

      // Stage 2: Setup
      const graph = this.falkorAdapter.selectGraph('codegraph-' + repo.id);

      if (!resume) {
        // Fresh run: clear all existing data before writing new data (Pitfall 1)
        await clearGraph(graph);
        await clearCheckpoint(graph, repo.id);
      }

      await createGraphIndexes(graph);
      const existingCheckpoint = await readCheckpoint(graph, repo.id);

      const memoryMonitor = new MemoryMonitor(this.config.indexer.memoryThresholdRatio);
      memoryMonitor.start();

      const embeddingQueue = new PQueue({ concurrency: this.config.indexer.embeddingConcurrency });
      const rows: Record<string, unknown>[] = [];
      const processedFiles = new Set<string>(existingCheckpoint);
      let filesSinceCheckpoint = 0;

      // Delete old embeddings once at start (fresh run only) so incremental flushes can just append
      if (!resume) {
        const tableNames = await this.lanceAdapter.getConnection().tableNames();
        if (tableNames.includes('embeddings')) {
          await this.lanceAdapter.deleteRows('embeddings', `repoId = '${repo.id}'`);
        }
      }

      /** Flush accumulated embedding rows to LanceDB and clear the buffer. */
      const flushEmbeddingRows = async () => {
        if (rows.length === 0) return;
        const tableNames = await this.lanceAdapter.getConnection().tableNames();
        if (tableNames.includes('embeddings')) {
          await this.lanceAdapter.addRows('embeddings', rows);
        } else {
          await this.lanceAdapter.createOrOverwriteTable('embeddings', rows);
        }
        rows.length = 0;
      };

      // Stage 3 — Pass 1: Stream files, parse, write symbols, queue embeddings
      for await (const file of walkRepo(destPath, { maxFileSizeBytes: this.config.indexer.maxFileSizeBytes })) {
        // Skip files already indexed (checkpoint resume)
        if (existingCheckpoint.has(file.relativePath)) {
          continue;
        }

        // Backpressure safety valve — pause if heap is under pressure
        await memoryMonitor.waitIfPaused();

        let source: string | null;
        try {
          source = await readSourceFile(file.absolutePath);
        } catch {
          source = null;
        }

        if (source === null) {
          result.failedFiles.push({ path: file.relativePath, error: 'Could not read file' });
          this.progressEmitter?.emit('file:skipped', {
            repoId: repo.id,
            filePath: file.relativePath,
            reason: 'error',
          });
          continue;
        }

        try {
          const langConfig = LANGUAGE_REGISTRY[path.extname(file.absolutePath).toLowerCase()];
          if (!langConfig) {
            // No parser for this extension — skip silently
            source = null;
            continue;
          }

          const parser = PARSERS[langConfig.language];
          const tree = parser.parse(source);
          const symbols = langConfig.extractor(tree, source, file.relativePath);

          // Extract call site names from AST
          const callSiteNames = extractCallSiteNames(tree.rootNode);
          symbols.callSites = callSiteNames.map((calleeName) => ({
            calleeName,
            callerFilePath: file.relativePath,
          }));

          // Write symbols to FalkorDB (CRITICAL ordering: parse → write → extract chunks → null source)
          const edgesFromFile = await writeFileSymbols(graph, repo.id, file, symbols);
          result.edgesCreated += edgesFromFile;

          // Extract chunks for embedding (needs source text)
          const chunks = extractChunks(symbols, source, file.relativePath, file.language);

          // Queue embedding for each chunk with backpressure
          if (chunks.length > 0) {
            await embeddingQueue.onSizeLessThan(this.config.indexer.embeddingQueueSize);
            for (const chunk of chunks) {
              void embeddingQueue.add(async () => {
                const row = await embedSingleChunk(chunk, repo.id, this.ollamaAdapter, EMBED_MODEL);
                if (row) rows.push(row);
              });
            }
            this.progressEmitter?.emit('embedding:queued', {
              repoId: repo.id,
              chunks: chunks.length,
            });
          }

          // Count symbols extracted
          result.symbolsExtracted +=
            symbols.functions.length + symbols.classes.length +
            symbols.types.length + symbols.imports.length;

          // Null out source text and tree references — allow GC to reclaim memory
          source = null;

          result.filesProcessed++;
          processedFiles.add(file.relativePath);
          filesSinceCheckpoint++;

          // Persist checkpoint periodically (not every file — reduces JSON serialization pressure)
          if (filesSinceCheckpoint >= CHECKPOINT_INTERVAL) {
            await writeCheckpoint(graph, repo.id, processedFiles);
            filesSinceCheckpoint = 0;
            this.progressEmitter?.emit('checkpoint:saved', {
              repoId: repo.id,
              filesProcessed: result.filesProcessed,
            });
          }

          // Flush embedding rows periodically to bound memory
          if (rows.length >= EMBEDDING_FLUSH_SIZE) {
            await embeddingQueue.onIdle(); // drain queue before flushing
            await flushEmbeddingRows();
          }

          this.progressEmitter?.emit('file:parsed', {
            repoId: repo.id,
            filePath: file.relativePath,
            symbolsFound: symbols.functions.length + symbols.classes.length + symbols.types.length,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[pipeline] Parse error: ${file.relativePath}: ${msg}`);
          result.failedFiles.push({ path: file.relativePath, error: msg });
          source = null;
        }
      }

      this.progressEmitter?.emit('pass1:complete', {
        repoId: repo.id,
        filesProcessed: result.filesProcessed,
        symbolsExtracted: result.symbolsExtracted,
      });

      // Final checkpoint write (covers files since last periodic checkpoint)
      if (filesSinceCheckpoint > 0) {
        await writeCheckpoint(graph, repo.id, processedFiles);
      }

      // Stage 4 — Drain embedding queue and flush remaining rows
      await embeddingQueue.onIdle();
      result.embeddingsStored = rows.length;
      result.embeddingsFailed = 0;
      await flushEmbeddingRows();

      // Stage 5 — Pass 2: Stream files again, extract call sites, resolve via FalkorDB, write CALLS edges
      for await (const file of walkRepo(destPath, { maxFileSizeBytes: this.config.indexer.maxFileSizeBytes })) {
        let source: string | null;
        try {
          source = await readSourceFile(file.absolutePath);
        } catch {
          source = null;
        }
        if (source === null) continue;

        try {
          const langConfig = LANGUAGE_REGISTRY[path.extname(file.absolutePath).toLowerCase()];
          if (!langConfig) {
            source = null;
            continue;
          }

          const parser = PARSERS[langConfig.language];
          const tree = parser.parse(source);
          const callSiteNames = extractCallSiteNames(tree.rootNode);
          source = null; // release early

          if (callSiteNames.length === 0) continue;

          // Batch all call site names for this file into one UNWIND query (single round trip)
          const uniqueNames = [...new Set(callSiteNames)];
          const queryResult = await graph.query(
            `UNWIND $names AS calleeName
             OPTIONAL MATCH (sf:Function {name: calleeName, filePath: $callerFilePath, repoId: $repoId})
             OPTIONAL MATCH (bf:Function {name: calleeName, repoId: $repoId})
             RETURN calleeName,
                    sf.name AS sameFileName, sf.filePath AS sameFilePath,
                    bf.name AS bareName, bf.filePath AS bareFilePath`,
            { params: { names: uniqueNames, callerFilePath: file.relativePath, repoId: repo.id } },
          );

          if (!queryResult.data || queryResult.data.length === 0) continue;

          // Find the caller function in this file (best-effort: first function found)
          const callerResult = await graph.query(
            'MATCH (f:Function {filePath: $callerFilePath, repoId: $repoId}) RETURN f.name LIMIT 1',
            { params: { callerFilePath: file.relativePath, repoId: repo.id } },
          );

          const callerRow = callerResult.data?.[0] as Record<string, unknown> | undefined;
          const callerName = callerRow?.['f.name'] as string | undefined;
          if (!callerName) continue;

          // Build call edges from resolved call sites
          const fileCallEdges = [];
          for (const row of queryResult.data as Record<string, unknown>[]) {
            const sameFilePath = row['sameFilePath'] as string | undefined;
            const bareFilePath = row['bareFilePath'] as string | undefined;

            const calleeName = row['sameFileName'] ?? row['bareName'];
            const calleeFilePath = sameFilePath ?? bareFilePath;

            if (!calleeName || !calleeFilePath) continue;

            fileCallEdges.push({
              callerName,
              callerFilePath: file.relativePath,
              calleeName: calleeName as string,
              calleeFilePath: calleeFilePath as string,
              crossFile: calleeFilePath !== file.relativePath,
            });
          }

          if (fileCallEdges.length > 0) {
            const written = await writeCallEdges(graph, repo.id, fileCallEdges);
            result.edgesCreated += written;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[pipeline] Pass 2 error: ${file.relativePath}: ${msg}`);
          source = null;
        }
      }

      // Stage 6 — Cleanup
      memoryMonitor.stop();
      await clearCheckpoint(graph, repo.id);

      this.progressEmitter?.emit('done', {
        repoId: repo.id,
        filesProcessed: result.filesProcessed,
        symbolsExtracted: result.symbolsExtracted,
      });
    } finally {
      // Always clean up — disk usage grows unbounded otherwise
      await rm(destPath, { recursive: true, force: true }).catch(() => {});
    }

    return result;
  }
}

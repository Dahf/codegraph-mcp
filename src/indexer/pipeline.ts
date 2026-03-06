import path from 'node:path';
import { rm } from 'node:fs/promises';
import type Parser from 'tree-sitter';
import type { FalkorDBAdapter } from '../adapters/falkordb.js';
import type { OllamaAdapter } from '../adapters/ollama.js';
import type { LanceDBAdapter } from '../adapters/lancedb.js';
import type {
  Config,
  RepoConfig,
  IndexResult,
  ExtractedSymbols,
  SourceFile,
  FunctionNode,
  CallEdge,
} from '../types/index.js';
import { cloneRepo } from './cloner.js';
import { walkRepo, readSourceFile } from './walker.js';
import { LANGUAGE_REGISTRY, PARSERS } from './parsers/registry.js';
import { writeGraph } from './graph-writer.js';
import { extractChunks } from './chunker.js';
import { embedAndStore } from './embedder.js';

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
    private readonly ollamaAdapter: OllamaAdapter,
    private readonly lanceAdapter: LanceDBAdapter,
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
      // Clone errors propagate up — the route handler catches and returns HTTP 400/500.
      // No graph writes happen before a successful clone.
      await cloneRepo(repo.url, repo.branch, repo.id, this.config.dataDir);

      // Stage 2: Walk
      const files = await walkRepo(destPath);

      // Stage 3: Parse — collect all symbols for two-pass call resolution
      // We also capture the parsed tree for call-site extraction after symbols are done.
      const allSymbols: Array<{ file: SourceFile; symbols: ExtractedSymbols }> = [];
      const allTrees: Array<{ file: SourceFile; tree: Parser.Tree }> = [];
      const sourceTexts = new Map<string, string>();

      for (const file of files) {
        try {
          const source = await readSourceFile(file.absolutePath);
          if (source === null) {
            result.failedFiles.push({ path: file.relativePath, error: 'Could not read file' });
            continue;
          }

          sourceTexts.set(file.relativePath, source);

          const langConfig = LANGUAGE_REGISTRY[path.extname(file.absolutePath).toLowerCase()];
          if (!langConfig) continue;

          const parser = PARSERS[langConfig.language];
          const tree = parser.parse(source);
          const symbols = langConfig.extractor(tree, source, file.relativePath);

          allSymbols.push({ file, symbols });
          allTrees.push({ file, tree });

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

      // Stage 3b: Extract call sites via generic tree-walk
      // Populate callSites on each file's symbols object
      for (let i = 0; i < allSymbols.length; i++) {
        const treeEntry = allTrees[i];
        if (!treeEntry) continue;
        const calleeNames = extractCallSiteNames(treeEntry.tree.rootNode);
        allSymbols[i]!.symbols.callSites = calleeNames.map((calleeName) => ({
          calleeName,
          callerFilePath: allSymbols[i]!.file.relativePath,
        }));
      }

      // Stage 4: Two-pass call-graph resolution and FalkorDB write

      // Pass 1: Build symbol map from all extracted functions
      const symbolMap = new Map<string, FunctionNode>();
      for (const { symbols } of allSymbols) {
        for (const fn of symbols.functions) {
          const qualKey = `${fn.filePath}::${fn.name}`;
          symbolMap.set(qualKey, fn);
          // Bare name fallback — first-match wins, no overwrite
          if (!symbolMap.has(fn.name)) symbolMap.set(fn.name, fn);
        }
      }

      // Pass 2: Resolve call sites to typed CallEdge objects
      const callEdges: CallEdge[] = [];
      for (const { symbols } of allSymbols) {
        for (const callSite of symbols.callSites) {
          const sameFileKey = `${callSite.callerFilePath}::${callSite.calleeName}`;
          const callee = symbolMap.get(sameFileKey) ?? symbolMap.get(callSite.calleeName);
          if (!callee) continue; // drop silently — callee not in this repo

          const crossFile = callee.filePath !== callSite.callerFilePath;

          // Find the first function in the same file as the call site — best-effort
          const caller = [...symbolMap.values()].find(
            (fn) => fn.filePath === callSite.callerFilePath,
          );
          if (!caller) continue;

          callEdges.push({
            callerName: caller.name,
            callerFilePath: callSite.callerFilePath,
            calleeName: callee.name,
            calleeFilePath: callee.filePath,
            crossFile,
          });
        }
      }

      // Write symbols and edges to FalkorDB
      result.edgesCreated = await writeGraph(repo.id, allSymbols, callEdges, this.falkorAdapter);

      // Stage 5: Embed and store vectors in LanceDB
      // Wrapped in its own try/catch so embedding failure does not affect graph data
      try {
        const chunks = allSymbols.flatMap(({ file, symbols }) => {
          const source = sourceTexts.get(file.relativePath) ?? '';
          return extractChunks(symbols, source, file.relativePath, file.language);
        });

        if (chunks.length > 0) {
          const { stored, failed } = await embedAndStore(
            chunks,
            repo.id,
            this.ollamaAdapter,
            this.lanceAdapter,
            { model: 'nomic-embed-text', concurrency: 5 },
          );
          result.embeddingsStored = stored;
          result.embeddingsFailed = failed;
        } else {
          result.embeddingsStored = 0;
          result.embeddingsFailed = 0;
        }
      } catch (err) {
        console.error(`[pipeline] Embedding stage failed: ${err}`);
        result.embeddingsStored = 0;
        result.embeddingsFailed = -1; // signals total failure
      }

    } finally {
      // Always clean up — disk usage grows unbounded otherwise
      await rm(destPath, { recursive: true, force: true }).catch(() => {});
    }

    return result;
  }
}

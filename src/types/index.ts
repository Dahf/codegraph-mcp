// Re-export Zod-inferred types from config schema
export type { Config, RepoConfig } from '../config/schema.js';

/**
 * Common interface implemented by all external service adapters.
 */
export interface Adapter {
  connect(): Promise<void>;
  healthCheck(): Promise<{ ok: boolean; message: string }>;
  close(): Promise<void>;
}

/**
 * All external adapters used by the server, grouped for easy passing and shutdown.
 * Each adapter implements the Adapter interface.
 */
export interface Adapters {
  falkordb: Adapter;
  lancedb: Adapter;
  ollama: Adapter;
}

/**
 * Runtime state of the server, including startup time and adapter health.
 */
export interface ServerState {
  /** Loaded and validated configuration */
  config: import('../config/schema.js').Config;

  /** Timestamp when the server was started */
  startTime: Date;

  /** Connected adapters for all external dependencies */
  adapters: Adapters;
}

// ── Indexer types ─────────────────────────────────────────────────────────────

/** A source file found during directory walk */
export interface SourceFile {
  /** Absolute path to the file */
  absolutePath: string;
  /** Path relative to the repo root (used as filePath in graph nodes) */
  relativePath: string;
  /** Language label: typescript | tsx | javascript | python | rust | go | cpp */
  language: string;
}

/** A function or method extracted from source */
export interface FunctionNode {
  name: string;
  filePath: string;       // relative path within repo
  startLine: number;      // 1-indexed (TreeSitter row + 1)
  endLine: number;        // 1-indexed
  signature: string;      // first 200 chars of the node's source text
  language: string;
  /** Set when this function is a method — used as MERGE key to avoid collision */
  className?: string;
}

/** A class extracted from source */
export interface ClassNode {
  name: string;
  filePath: string;
  startLine: number;
  endLine: number;
  language: string;
}

/** A type alias or interface extracted from source */
export interface TypeNode {
  name: string;
  filePath: string;
  startLine: number;
  endLine: number;
  language: string;
}

/** An import statement extracted from source */
export interface ImportNode {
  modulePath: string;    // the module being imported from
  filePath: string;      // file that contains this import
  symbols: string[];     // named symbols imported (empty for side-effect imports)
}

/** All symbols extracted from a single file parse */
export interface ExtractedSymbols {
  functions: FunctionNode[];
  classes: ClassNode[];
  types: TypeNode[];
  imports: ImportNode[];
  /**
   * Raw call sites found in this file — callee names from call_expression nodes.
   * Populated by the pipeline's tree-walk pass; empty array when not extracted.
   * Two-pass resolution in pipeline.ts converts these to typed CallEdge objects.
   */
  callSites: Array<{ calleeName: string; callerFilePath: string }>;
}

/** A directed call edge between two functions */
export interface CallEdge {
  callerName: string;
  callerFilePath: string;
  callerClassName?: string;
  calleeName: string;
  calleeFilePath: string;
  /** true when caller and callee are in different files */
  crossFile: boolean;
}

/** Result returned by IndexPipeline.run() and the index REST endpoints */
export interface IndexResult {
  repoId: string;
  filesProcessed: number;
  symbolsExtracted: number;
  edgesCreated: number;
  failedFiles: Array<{ path: string; error: string }>;
  /** Number of embedding vectors successfully stored (Phase 3+) */
  embeddingsStored?: number;
  /** Number of embedding vectors that failed to generate or store (Phase 3+) */
  embeddingsFailed?: number;
}

// ── Query result types (Phase 4) ──────────────────────────────────────────────

/** A named symbol match returned by the Symbol Lookup tool (lookup_symbol) */
export interface SymbolResult {
  /** Symbol kind: 'function' | 'class' | 'type' */
  symbolType: string;
  /** Name of the symbol */
  symbolName: string;
  /** File path relative to repo root */
  filePath: string;
  /** 1-indexed start line */
  startLine: number;
  /** 1-indexed end line */
  endLine: number;
  /** Language of the source file */
  language: string;
  /** Repository this symbol belongs to */
  repoId: string;
  /** Full source text (fetched from LanceDB; empty string if not indexed) */
  sourceText: string;
  /** Functions that directly call this symbol (empty for Class/Type nodes) */
  callers: Array<{ name: string; filePath: string; repoId: string }>;
  /** Functions this symbol directly calls (empty for Class/Type nodes) */
  callees: Array<{ name: string; filePath: string; repoId: string }>;
}

/** A single code match returned by the Semantic Search tool (search_code) */
export interface SearchResult {
  /** Full source text of the matched symbol */
  sourceText: string;
  /** File path relative to repo root */
  filePath: string;
  /** Name of the matched symbol (function/class name) */
  symbolName: string;
  /** Symbol kind: 'function' | 'class' | 'type' */
  symbolType: string;
  /** 1-indexed start line in the file */
  startLine: number;
  /** 1-indexed end line in the file */
  endLine: number;
  /** Language of the source file */
  language: string;
  /** Repository this symbol belongs to */
  repoId: string;
  /** Cosine similarity score in [0, 1] — higher is more similar */
  score: number;
}

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
}

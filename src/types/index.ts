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

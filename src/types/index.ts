// Re-export Zod-inferred types from config schema
export type { Config, RepoConfig } from '../config/schema.js';

/**
 * Runtime state of the server, including startup time and adapter health.
 */
export interface ServerState {
  /** Loaded and validated configuration */
  config: import('../config/schema.js').Config;

  /** Timestamp when the server was started */
  startTime: Date;

  /** Health status of each external adapter */
  adapters: {
    falkordb: 'ok' | 'error' | 'unknown';
    lancedb: 'ok' | 'error' | 'unknown';
    ollama: 'ok' | 'error' | 'unknown';
  };
}

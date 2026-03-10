import type { Config } from './schema.js';

export const defaultConfig: Config = {
  port: 4444,
  dataDir: './data',
  falkordb: {
    host: 'localhost',
    port: 6379,
  },
  lancedb: {
    path: './data/vectors',
  },
  ollama: {
    host: 'http://localhost:11434',
  },
  repos: [],
  indexer: {
    maxFileSizeBytes: 1_048_576,
    embeddingConcurrency: 5,
    memoryThresholdRatio: 0.80,
    embeddingQueueSize: 500,
  },
};

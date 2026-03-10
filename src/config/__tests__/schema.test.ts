import { describe, it, expect } from 'vitest';
import { ConfigSchema } from '../schema.js';

describe('ConfigSchema indexer field', () => {
  it('should parse empty config with default indexer values', () => {
    const result = ConfigSchema.parse({});
    expect(result.indexer).toBeDefined();
    expect(result.indexer.maxFileSizeBytes).toBe(1_048_576);
    expect(result.indexer.embeddingConcurrency).toBe(5);
    expect(result.indexer.memoryThresholdRatio).toBe(0.80);
    expect(result.indexer.embeddingQueueSize).toBe(500);
  });

  it('should allow overriding maxFileSizeBytes while keeping other defaults', () => {
    const result = ConfigSchema.parse({ indexer: { maxFileSizeBytes: 2_000_000 } });
    expect(result.indexer.maxFileSizeBytes).toBe(2_000_000);
    expect(result.indexer.embeddingConcurrency).toBe(5);
    expect(result.indexer.memoryThresholdRatio).toBe(0.80);
    expect(result.indexer.embeddingQueueSize).toBe(500);
  });

  it('should fail validation for memoryThresholdRatio below 0.5', () => {
    expect(() => ConfigSchema.parse({ indexer: { memoryThresholdRatio: 0.3 } })).toThrow();
  });

  it('should fail validation for embeddingConcurrency of 0', () => {
    expect(() => ConfigSchema.parse({ indexer: { embeddingConcurrency: 0 } })).toThrow();
  });

  it('should parse config without indexer key (backwards compatibility)', () => {
    const result = ConfigSchema.parse({ port: 3000 });
    expect(result.indexer).toBeDefined();
    expect(result.indexer.maxFileSizeBytes).toBe(1_048_576);
  });
});

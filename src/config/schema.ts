import { z } from 'zod';

// Custom git URL validator accepting both HTTPS and SSH formats
// z.string().url() rejects SSH URLs (git@github.com:org/repo.git) — use regex instead
const gitUrlRegex = /^(https?:\/\/|git@)[^\s]+$/;

export const RepoSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1).optional(),
    url: z.string().regex(gitUrlRegex, 'Must be a valid HTTPS or SSH git URL'),
    branch: z.string().default('main'),
    addedAt: z.string().datetime(),
  })
  .transform((repo) => ({
    ...repo,
    // Derive name from URL if not provided (backwards compat for existing configs)
    name: repo.name ?? repo.url.split('/').pop()?.replace(/\.git$/, '') ?? repo.url,
  }));

export const ConfigSchema = z.object({
  port: z.number().int().min(1).max(65535).default(4444),
  dataDir: z.string().default('./data'),
  falkordb: z.object({
    host: z.string().default('localhost'),
    port: z.number().int().min(1).max(65535).default(6379),
  }).default({ host: 'localhost', port: 6379 }),
  lancedb: z.object({
    path: z.string().default('./data/vectors'),
  }).default({ path: './data/vectors' }),
  ollama: z.object({
    host: z.string().default('http://localhost:11434'),
  }).default({ host: 'http://localhost:11434' }),
  repos: z.array(RepoSchema).default([]),
  indexer: z.object({
    maxFileSizeBytes: z.number().int().positive().default(1_048_576),
    embeddingConcurrency: z.number().int().min(1).max(20).default(5),
    memoryThresholdRatio: z.number().min(0.5).max(0.95).default(0.80),
    embeddingQueueSize: z.number().int().positive().default(500),
  }).default({
    maxFileSizeBytes: 1_048_576,
    embeddingConcurrency: 5,
    memoryThresholdRatio: 0.80,
    embeddingQueueSize: 500,
  }),
});

export type Config = z.infer<typeof ConfigSchema>;
export type RepoConfig = z.infer<typeof RepoSchema>;

---
phase: "07"
plan: "01"
subsystem: indexer
tags: [config, walker, streaming, memory, tdd]
dependency_graph:
  requires: []
  provides: [ConfigSchema.indexer, walkRepo-async-generator, p-queue]
  affects: [src/indexer/pipeline.ts, src/config/defaults.ts]
tech_stack:
  added: [p-queue, vitest]
  patterns: [async-generator, pull-based-directory-iteration, zod-nested-defaults]
key_files:
  created:
    - src/config/__tests__/schema.test.ts
    - src/indexer/__tests__/walker.test.ts
    - vitest.config.ts
  modified:
    - src/config/schema.ts
    - src/config/defaults.ts
    - src/indexer/walker.ts
    - src/indexer/pipeline.ts
    - package.json
decisions:
  - "Zod v4 requires explicit full default object (not {}) for nested object defaults to propagate — .default({}) stores the literal empty object, not the schema-computed defaults"
  - "walkRepo uses opendir() for pull-based iteration instead of readdir() to avoid loading entire directory listings into memory at once"
  - "pipeline.ts passes config.indexer.maxFileSizeBytes to walkRepo so file-size filtering is config-driven from the start"
metrics:
  duration: "~8 min"
  completed: "2026-03-10"
  tasks_completed: 2
  files_modified: 8
---

# Phase 07 Plan 01: Config Schema, Walker Async Generator, and p-queue Install Summary

**One-liner:** Config schema extended with four indexer fields (maxFileSizeBytes, embeddingConcurrency, memoryThresholdRatio, embeddingQueueSize), walkRepo converted to pull-based async generator with file-size filtering, p-queue and vitest installed.

## What Was Built

### Task 1: Config schema extension and p-queue install

Added `indexer` field to `ConfigSchema` in `src/config/schema.ts`:

```typescript
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
```

Installed `p-queue` (bounded embedding queue) and `vitest` (test framework, was missing).

5/5 schema tests pass.

### Task 2: Convert walkRepo to async generator with file-size filtering

Changed `walkRepo` from `Promise<SourceFile[]>` to `AsyncGenerator<SourceFile>`:

```typescript
export async function* walkRepo(
  repoRoot: string,
  options?: { maxFileSizeBytes?: number },
): AsyncGenerator<SourceFile>
```

Uses `opendir()` instead of `readdir()` for pull-based directory iteration. Adds `stat()` check per file when `maxFileSizeBytes` is set — files exceeding the threshold are skipped with a warning log. All existing filtering (NOISE_DIRS, NOISE_SUFFIXES, language registry) is unchanged.

9/9 walker tests pass.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing functionality] Zod v4 nested defaults require explicit full default object**
- **Found during:** Task 1 GREEN phase
- **Issue:** `z.object({...}).default({})` in Zod v4 stores the literal `{}` as the default, not the schema-computed defaults. Fields were `undefined` when the outer key was missing.
- **Fix:** Changed `.default({})` to `.default({ maxFileSizeBytes: 1_048_576, ... })` with all four fields explicitly listed.
- **Files modified:** `src/config/schema.ts`
- **Commit:** a164fd1

**2. [Rule 3 - Blocking] defaults.ts missing indexer field after Config type update**
- **Found during:** Task 2 TypeScript check
- **Issue:** `src/config/defaults.ts` exports `defaultConfig: Config` but did not include the new `indexer` field, causing TS2741 error.
- **Fix:** Added `indexer` with all four default values matching the schema defaults.
- **Files modified:** `src/config/defaults.ts`
- **Commit:** 4372dae

**3. [Rule 1 - Bug] pipeline.ts used sync for-of on async generator**
- **Found during:** Task 2 TypeScript check
- **Issue:** `for (const file of files)` on an `AsyncGenerator` is invalid — TS2488 error.
- **Fix:** Changed to `for await (const file of fileGen)` and wired `config.indexer.maxFileSizeBytes` to the walker options.
- **Files modified:** `src/indexer/pipeline.ts`
- **Commit:** 4372dae

**4. [Rule 3 - Blocking] vitest not installed**
- **Found during:** Task 1 RED phase setup
- **Issue:** No test framework existed in the project. Plan assumed vitest was available.
- **Fix:** Installed vitest as devDependency and created `vitest.config.ts`.
- **Files modified:** `package.json`, `vitest.config.ts`
- **Commit:** b834300

## Verification Results

```
npx vitest run src/config/__tests__/schema.test.ts src/indexer/__tests__/walker.test.ts
Test Files  2 passed (2)
Tests       14 passed (14)

npx tsc --noEmit
(no errors)
```

## Self-Check: PASSED

All files verified present. All commits verified in git log.

## Must-Haves Check

- [x] Config schema has indexer.maxFileSizeBytes, indexer.embeddingConcurrency, indexer.memoryThresholdRatio, indexer.embeddingQueueSize — all with defaults
- [x] walkRepo is an async generator yielding SourceFile one at a time
- [x] File-size filtering skips files over maxFileSizeBytes threshold
- [x] p-queue is installed as a dependency
- [x] Existing configs without indexer field still parse without error

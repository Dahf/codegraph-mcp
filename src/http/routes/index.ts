/**
 * Index route handlers.
 *
 * POST /repos/index-all  — trigger indexing for all registered repositories (sequential)
 * POST /repos/:id/index  — trigger indexing for a single repository by ID
 *
 * Non-incremental endpoints are synchronous — the request blocks until indexing completes.
 * Incremental endpoint (?incremental=true) returns 202 Accepted immediately and runs
 * the pipeline asynchronously with per-repo debounce (5 s) and an in-progress lock.
 *
 * Query parameters:
 *   ?resume=true       — resume a previously interrupted index run using checkpoint data.
 *                        When set, the pipeline skips already-processed files and does not
 *                        clear the graph or existing checkpoint before indexing.
 *   ?incremental=true  — trigger incremental re-index (fire-and-forget, 202 Accepted).
 *                        Rapid successive triggers within a 5 s window are debounced into
 *                        a single run. If a run is already in-progress for the same repo,
 *                        subsequent triggers are silently dropped.
 *
 * IMPORTANT: /repos/index-all must be declared BEFORE /repos/:id/index in the router
 * so Express does not match the literal string "index-all" as an :id parameter.
 */
import path from 'node:path';
import { Router } from 'express';
import type { FalkorDBAdapter } from '../../adapters/falkordb.js';
import type { OllamaAdapter } from '../../adapters/ollama.js';
import type { LanceDBAdapter } from '../../adapters/lancedb.js';
import type { Config } from '../../types/index.js';
import type { RepoManager } from '../../repos/manager.js';
import { IndexPipeline } from '../../indexer/pipeline.js';
import { IndexProgressEmitter } from '../../indexer/progress.js';
import { installPostCommitHook } from '../../indexer/hook-installer.js';

/** Debounce window for incremental re-index triggers (ms). */
const DEBOUNCE_MS = 5000;

/**
 * Create a progress emitter that logs indexing events to console.
 * Prepared for Phase 6 dashboard integration — events will be forwarded
 * to SSE/WebSocket connections in addition to console logging.
 */
function createProgressEmitter(): IndexProgressEmitter {
  const emitter = new IndexProgressEmitter();
  emitter.on('file:parsed', (data) => {
    console.log(`[index] Parsed: ${data.filePath} (${data.symbolsFound} symbols)`);
  });
  emitter.on('file:skipped', (data) => {
    console.log(`[index] Skipped: ${data.filePath} (reason: ${data.reason})`);
  });
  emitter.on('memory:paused', (data) => {
    console.log(`[index] Memory pressure — pausing (heap: ${(data.heapRatio * 100).toFixed(1)}%)`);
  });
  emitter.on('memory:resumed', (_data) => {
    console.log(`[index] Memory pressure resolved — resuming`);
  });
  emitter.on('pass1:complete', (data) => {
    console.log(`[index] Pass 1 complete: ${data.filesProcessed} files, ${data.symbolsExtracted} symbols`);
  });
  emitter.on('incremental:started', (data) => {
    console.log(`[index] Incremental started: ${data.changedFiles} changed, ${data.deletedFiles} deleted`);
  });
  emitter.on('done', (data) => {
    console.log(`[index] Complete: ${data.filesProcessed} files, ${data.symbolsExtracted} symbols`);
  });
  return emitter;
}

export function indexRoutes(
  repoManager: RepoManager,
  falkorAdapter: FalkorDBAdapter,
  ollamaAdapter: OllamaAdapter,
  lanceAdapter: LanceDBAdapter,
  config: Config,
): Router {
  const router = Router();

  /**
   * Per-repo debounce timers for incremental triggers.
   * Stored in the factory closure — shared across requests for the same router instance.
   */
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Set of repoIds currently undergoing incremental indexing.
   * Used to drop subsequent triggers while a run is in-progress.
   */
  const inProgress = new Set<string>();

  // POST /repos/index-all — index all registered repos sequentially
  // Per-repo errors are caught and reported inline; other repos still run.
  router.post('/repos/index-all', async (req, res, next) => {
    try {
      const resume = req.query['resume'] === 'true';
      const repos = repoManager.list();
      const results = [];
      for (const repo of repos) {
        try {
          const emitter = createProgressEmitter();
          const pipeline = new IndexPipeline(falkorAdapter, ollamaAdapter, lanceAdapter, config, emitter);
          const result = await pipeline.run(repo, { resume });
          results.push(result);
          // Install post-commit hook after successful index
          const destPath = path.join(config.dataDir, 'repos', repo.id);
          try {
            await installPostCommitHook(destPath, repo.id);
          } catch (hookErr) {
            console.warn(`[index] Hook install failed for ${repo.id}: ${hookErr instanceof Error ? hookErr.message : String(hookErr)}`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          results.push({ repoId: repo.id, error: msg });
        }
      }
      res.status(200).json({ results });
    } catch (err) {
      next(err);
    }
  });

  // POST /repos/:id/index — index a single repo by ID
  // Clone errors and unhandled errors propagate to errorHandler (HTTP 500).
  router.post('/repos/:id/index', async (req, res, next) => {
    try {
      const incremental = req.query['incremental'] === 'true';
      const repos = repoManager.list();
      const repo = repos.find((r) => r.id === req.params['id']);
      if (!repo) {
        res.status(404).json({ error: 'Repository not found', id: req.params['id'] });
        return;
      }

      if (incremental) {
        // Return 202 Accepted immediately — pipeline runs asynchronously
        res.status(202).json({ status: 'queued', repoId: repo.id });

        // Fire-and-forget: clear existing debounce timer, set a new one
        const existingTimer = debounceTimers.get(repo.id);
        if (existingTimer !== undefined) {
          clearTimeout(existingTimer);
        }

        const timer = setTimeout(() => {
          debounceTimers.delete(repo.id);

          // Drop if already indexing
          if (inProgress.has(repo.id)) {
            console.log(`[index] Incremental trigger dropped — already indexing ${repo.id}`);
            return;
          }

          inProgress.add(repo.id);
          const emitter = createProgressEmitter();
          const pipeline = new IndexPipeline(falkorAdapter, ollamaAdapter, lanceAdapter, config, emitter);
          pipeline.run(repo, { incremental: true })
            .then(async () => {
              const destPath = path.join(config.dataDir, 'repos', repo.id);
              try {
                await installPostCommitHook(destPath, repo.id);
              } catch (hookErr) {
                console.warn(`[index] Hook install failed for ${repo.id}: ${hookErr instanceof Error ? hookErr.message : String(hookErr)}`);
              }
            })
            .catch((err: unknown) => {
              console.error(`[index] Incremental index failed for ${repo.id}: ${err instanceof Error ? err.message : String(err)}`);
            })
            .finally(() => {
              inProgress.delete(repo.id);
            });
        }, DEBOUNCE_MS);

        debounceTimers.set(repo.id, timer);
        return;
      }

      // Non-incremental (synchronous) path
      const resume = req.query['resume'] === 'true';
      const emitter = createProgressEmitter();
      const pipeline = new IndexPipeline(falkorAdapter, ollamaAdapter, lanceAdapter, config, emitter);
      const result = await pipeline.run(repo, { resume });

      // Install post-commit hook after successful index
      const destPath = path.join(config.dataDir, 'repos', repo.id);
      try {
        await installPostCommitHook(destPath, repo.id);
      } catch (hookErr) {
        console.warn(`[index] Hook install failed for ${repo.id}: ${hookErr instanceof Error ? hookErr.message : String(hookErr)}`);
      }

      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

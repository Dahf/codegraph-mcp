/**
 * Index route handlers.
 *
 * POST /repos/index-all  — trigger indexing for all registered repositories (sequential)
 * POST /repos/:id/index  — trigger indexing for a single repository by ID
 *
 * Both endpoints are synchronous — the request blocks until indexing completes.
 * Clone errors propagate to errorHandler as HTTP 500; 404 is returned for unknown repo IDs.
 *
 * Query parameters:
 *   ?resume=true  — resume a previously interrupted index run using checkpoint data.
 *                   When set, the pipeline skips already-processed files and does not
 *                   clear the graph or existing checkpoint before indexing.
 *
 * IMPORTANT: /repos/index-all must be declared BEFORE /repos/:id/index in the router
 * so Express does not match the literal string "index-all" as an :id parameter.
 */
import { Router } from 'express';
import type { FalkorDBAdapter } from '../../adapters/falkordb.js';
import type { OllamaAdapter } from '../../adapters/ollama.js';
import type { LanceDBAdapter } from '../../adapters/lancedb.js';
import type { Config } from '../../types/index.js';
import type { RepoManager } from '../../repos/manager.js';
import { IndexPipeline } from '../../indexer/pipeline.js';
import { IndexProgressEmitter } from '../../indexer/progress.js';

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
          results.push(await pipeline.run(repo, { resume }));
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
      const resume = req.query['resume'] === 'true';
      const repos = repoManager.list();
      const repo = repos.find((r) => r.id === req.params['id']);
      if (!repo) {
        res.status(404).json({ error: 'Repository not found', id: req.params['id'] });
        return;
      }
      const emitter = createProgressEmitter();
      const pipeline = new IndexPipeline(falkorAdapter, ollamaAdapter, lanceAdapter, config, emitter);
      const result = await pipeline.run(repo, { resume });
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

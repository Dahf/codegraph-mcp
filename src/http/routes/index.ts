/**
 * Index route handlers.
 *
 * POST /repos/index-all  — trigger indexing for all registered repositories (sequential)
 * POST /repos/:id/index  — trigger indexing for a single repository by ID
 *
 * Both endpoints are synchronous — the request blocks until indexing completes.
 * Clone errors propagate to errorHandler as HTTP 500; 404 is returned for unknown repo IDs.
 *
 * IMPORTANT: /repos/index-all must be declared BEFORE /repos/:id/index in the router
 * so Express does not match the literal string "index-all" as an :id parameter.
 */
import { Router } from 'express';
import type { FalkorDBAdapter } from '../../adapters/falkordb.js';
import type { Config } from '../../types/index.js';
import type { RepoManager } from '../../repos/manager.js';
import { IndexPipeline } from '../../indexer/pipeline.js';

export function indexRoutes(
  repoManager: RepoManager,
  falkorAdapter: FalkorDBAdapter,
  config: Config,
): Router {
  const router = Router();

  // POST /repos/index-all — index all registered repos sequentially
  // Per-repo errors are caught and reported inline; other repos still run.
  router.post('/repos/index-all', async (req, res, next) => {
    try {
      const repos = repoManager.list();
      const results = [];
      for (const repo of repos) {
        try {
          const pipeline = new IndexPipeline(falkorAdapter, config);
          results.push(await pipeline.run(repo));
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
      const repos = repoManager.list();
      const repo = repos.find((r) => r.id === req.params.id);
      if (!repo) {
        res.status(404).json({ error: 'Repository not found', id: req.params.id });
        return;
      }
      const pipeline = new IndexPipeline(falkorAdapter, config);
      const result = await pipeline.run(repo);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

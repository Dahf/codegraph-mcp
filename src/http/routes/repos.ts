import { Router } from 'express';
import type { RepoManager } from '../../repos/manager.js';

/**
 * Express router for repository management endpoints.
 *
 *   GET    /repos         — list all configured repositories
 *   POST   /repos         — add a new repository (url, branch?)
 *   DELETE /repos/:id     — remove a repository by ID
 */
export function repoRoutes(manager: RepoManager): Router {
  const router = Router();

  // GET /repos — return all repos as JSON array
  // Each repo includes Phase 1 stub fields: indexStatus (always "pending"),
  // lastIndexedCommit (always null) — populated in Phase 2 when indexing is implemented.
  router.get('/repos', (_req, res) => {
    const repos = manager.list().map((repo) => ({
      ...repo,
      indexStatus: 'pending' as const,
      lastIndexedCommit: null,
    }));
    res.json(repos);
  });

  // POST /repos — add a new repository
  // Body: { url: string, branch?: string, name?: string }
  router.post('/repos', (req, res) => {
    const { url, branch, name } = req.body as { url?: string; branch?: string; name?: string };

    // Validate url is present and non-empty
    if (!url || typeof url !== 'string' || url.trim() === '') {
      res.status(400).json({ error: 'url is required and must be a non-empty string' });
      return;
    }

    try {
      const repo = manager.add(url.trim(), branch?.trim(), name?.trim());
      res.status(201).json({
        ...repo,
        indexStatus: 'pending' as const,
        lastIndexedCommit: null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to add repository';
      res.status(400).json({ error: message });
    }
  });

  // DELETE /repos/:id — remove a repository by ID
  router.delete('/repos/:id', (req, res) => {
    const { id } = req.params;

    const removed = manager.remove(id);
    if (!removed) {
      res.status(404).json({ error: 'Repository not found' });
      return;
    }

    res.json({ deleted: true });
  });

  return router;
}

import { Router } from 'express';
import type { Adapters } from '../../types/index.js';
import type { RepoStore } from '../../repos/store.js';

/**
 * Express router for health check endpoints.
 *
 *   GET /health         — fast liveness check (200 all ok, 503 any error)
 *   GET /health/details — full stats including repo count and stub indexing metrics
 *
 * Compatible with Prometheus/uptime monitoring: all responses are JSON.
 */
export function healthRoutes(
  adapters: Adapters,
  store: RepoStore,
  startTime: Date
): Router {
  const router = Router();

  /**
   * Run all three adapter health checks in parallel.
   * Uses Promise.allSettled so a single failure doesn't block the others.
   */
  async function runHealthChecks(): Promise<{
    allOk: boolean;
    falkordb: 'ok' | 'error';
    lancedb: 'ok' | 'error';
    ollama: 'ok' | 'error';
  }> {
    const [falkorResult, lanceResult, ollamaResult] = await Promise.allSettled([
      adapters.falkordb.healthCheck(),
      adapters.lancedb.healthCheck(),
      adapters.ollama.healthCheck(),
    ]);

    const falkorOk =
      falkorResult.status === 'fulfilled' && falkorResult.value.ok;
    const lanceOk =
      lanceResult.status === 'fulfilled' && lanceResult.value.ok;
    const ollamaOk =
      ollamaResult.status === 'fulfilled' && ollamaResult.value.ok;

    return {
      allOk: falkorOk && lanceOk && ollamaOk,
      falkordb: falkorOk ? 'ok' : 'error',
      lancedb: lanceOk ? 'ok' : 'error',
      ollama: ollamaOk ? 'ok' : 'error',
    };
  }

  // GET /health — fast liveness check
  router.get('/health', async (_req, res) => {
    const checks = await runHealthChecks();

    const body = {
      status: checks.allOk ? 'ok' : 'error',
      uptime: process.uptime(),
      falkordb: checks.falkordb,
      lancedb: checks.lancedb,
      ollama: checks.ollama,
    };

    res.status(checks.allOk ? 200 : 503).json(body);
  });

  // GET /health/details — full stats
  // Indexing stats (indexedRepoCount, lastIndexTimestamp, totals) are stub values for Phase 1.
  // They will be populated by Phase 2 and 3 when indexing is implemented.
  router.get('/health/details', async (_req, res) => {
    const checks = await runHealthChecks();

    const body = {
      status: checks.allOk ? 'ok' : 'error',
      uptime: process.uptime(),
      falkordb: checks.falkordb,
      lancedb: checks.lancedb,
      ollama: checks.ollama,
      // Use live store count (not config snapshot) — repos can be added at runtime
      repoCount: store.getAll().length,
      // Phase 1 stubs — populated in Phase 2/3
      indexedRepoCount: 0,
      lastIndexTimestamp: null,
      totalFunctions: 0,
      totalClasses: 0,
      totalEmbeddings: 0,
    };

    res.status(checks.allOk ? 200 : 503).json(body);
  });

  // Suppress unused variable warning for startTime — kept in signature for future use
  void startTime;

  return router;
}

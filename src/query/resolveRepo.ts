import type { Config } from '../types/index.js';

/**
 * Resolve a repoName or repoId to a UUID repoId.
 *
 * Resolution order:
 * 1. If repoId is provided, use it directly (UUID passthrough).
 * 2. If repoName is provided, find the repo whose name matches (case-insensitive).
 * 3. If neither is provided, return undefined (search all repos).
 *
 * Returns { repoId, error }. If error is set, the repo could not be resolved.
 */
export function resolveRepo(
  config: Config,
  opts: { repoId?: string; repoName?: string },
): { repoId: string | undefined; error: string | undefined } {
  // Direct UUID passthrough
  if (opts.repoId) {
    return { repoId: opts.repoId, error: undefined };
  }

  // Name-based lookup
  if (opts.repoName) {
    const needle = opts.repoName.toLowerCase();
    const match = config.repos.find((r) => r.name.toLowerCase() === needle);
    if (match) {
      return { repoId: match.id, error: undefined };
    }
    const available = config.repos.map((r) => r.name).join(', ');
    return {
      repoId: undefined,
      error: `Repository "${opts.repoName}" not found. Available repos: ${available || '(none)'}`,
    };
  }

  // No filter — search all repos
  return { repoId: undefined, error: undefined };
}

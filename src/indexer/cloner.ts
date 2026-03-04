import { simpleGit } from 'simple-git';
import { rm, mkdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * Clone a git repository to dataDir/repos/repoId using --depth 1 (shallow).
 * Removes any stale clone at the destination before cloning.
 * Returns the absolute path to the cloned directory.
 *
 * NOTE for Phase 5: Remove --depth 1 when implementing incremental indexing
 * (PARS-10) — full history is needed for git diff-based change detection.
 */
export async function cloneRepo(
  url: string,
  branch: string,
  repoId: string,
  dataDir: string
): Promise<string> {
  const destPath = path.join(dataDir, 'repos', repoId);

  // Remove stale clone if present (re-index scenario)
  await rm(destPath, { recursive: true, force: true });
  await mkdir(destPath, { recursive: true });

  const git = simpleGit();
  await git.clone(url, destPath, [
    '--branch', branch,
    '--single-branch',
    '--depth', '1',
  ]);

  return destPath;
}

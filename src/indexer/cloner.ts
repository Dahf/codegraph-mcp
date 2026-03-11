import { simpleGit } from 'simple-git';
import { rm, mkdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * Clone a git repository to dataDir/repos/repoId (full clone, no --depth 1).
 * Removes any stale clone at the destination before cloning.
 * Returns the absolute path to the cloned directory.
 *
 * Full clone is required for git diff-based incremental indexing (PARS-10).
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
  ]);

  return destPath;
}

/**
 * Pull the latest changes in an existing clone directory.
 * Used for incremental re-indexing to update the clone without a full re-clone.
 */
export async function pullRepo(destPath: string): Promise<void> {
  const git = simpleGit(destPath);
  await git.pull();
}

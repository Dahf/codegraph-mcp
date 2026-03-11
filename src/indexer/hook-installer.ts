import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * Install a post-commit git hook in the cloned repo that triggers
 * incremental re-indexing via HTTP POST to the CodeGraph server.
 *
 * The hook is fire-and-forget: it backgrounds the curl request and exits
 * immediately so it never blocks the git commit.
 *
 * Idempotent — overwrites any existing post-commit hook at the path.
 */
export async function installPostCommitHook(destPath: string, repoId: string): Promise<void> {
  const hookDir = path.join(destPath, '.git', 'hooks');
  const hookPath = path.join(hookDir, 'post-commit');

  const content = [
    '#!/bin/sh',
    '# Auto-installed by CodeGraph MCP — do not edit',
    '# Triggers incremental re-indexing on commit. Fire-and-forget.',
    'SERVER_URL="${CODEGRAPH_SERVER_URL:-http://localhost:3000}"',
    `curl -s -X POST "$SERVER_URL/repos/${repoId}/index?incremental=true" > /dev/null 2>&1 &`,
    'exit 0',
    '',
  ].join('\n');

  await mkdir(hookDir, { recursive: true });
  await writeFile(hookPath, content, { mode: 0o755 });
}

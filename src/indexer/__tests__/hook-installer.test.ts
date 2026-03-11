/**
 * Unit tests for installPostCommitHook (Phase 5, Plan 2).
 *
 * Uses real filesystem operations in a temp directory — simpler and more
 * reliable than mocking fs/promises.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { installPostCommitHook } from '../hook-installer.js';

let tempDir: string | null = null;

async function makeTempDir(): Promise<string> {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'hook-installer-test-'));
  return tempDir;
}

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe('installPostCommitHook', () => {
  it('creates the .git/hooks/ directory if it does not exist', async () => {
    const destPath = await makeTempDir();
    await installPostCommitHook(destPath, 'my-repo');
    const hooksDir = path.join(destPath, '.git', 'hooks');
    const s = await stat(hooksDir);
    expect(s.isDirectory()).toBe(true);
  });

  it('writes the hook file at .git/hooks/post-commit', async () => {
    const destPath = await makeTempDir();
    await installPostCommitHook(destPath, 'my-repo');
    const hookPath = path.join(destPath, '.git', 'hooks', 'post-commit');
    const s = await stat(hookPath);
    expect(s.isFile()).toBe(true);
  });

  it('hook script starts with #!/bin/sh shebang', async () => {
    const destPath = await makeTempDir();
    await installPostCommitHook(destPath, 'repo-1');
    const hookPath = path.join(destPath, '.git', 'hooks', 'post-commit');
    const content = await readFile(hookPath, 'utf8');
    expect(content.startsWith('#!/bin/sh')).toBe(true);
  });

  it('interpolates repoId into the curl command at install time', async () => {
    const destPath = await makeTempDir();
    await installPostCommitHook(destPath, 'my-specific-repo');
    const hookPath = path.join(destPath, '.git', 'hooks', 'post-commit');
    const content = await readFile(hookPath, 'utf8');
    expect(content).toContain('/repos/my-specific-repo/index?incremental=true');
  });

  it('hook uses curl POST method', async () => {
    const destPath = await makeTempDir();
    await installPostCommitHook(destPath, 'repo-1');
    const hookPath = path.join(destPath, '.git', 'hooks', 'post-commit');
    const content = await readFile(hookPath, 'utf8');
    expect(content).toContain('curl');
    expect(content).toContain('-X POST');
  });

  it('hook backgrounds the curl request with & (fire-and-forget)', async () => {
    const destPath = await makeTempDir();
    await installPostCommitHook(destPath, 'repo-1');
    const hookPath = path.join(destPath, '.git', 'hooks', 'post-commit');
    const content = await readFile(hookPath, 'utf8');
    // The curl line should end with & before newline
    expect(content).toMatch(/curl.*&/);
  });

  it('hook ends with exit 0', async () => {
    const destPath = await makeTempDir();
    await installPostCommitHook(destPath, 'repo-1');
    const hookPath = path.join(destPath, '.git', 'hooks', 'post-commit');
    const content = await readFile(hookPath, 'utf8');
    expect(content).toContain('exit 0');
  });

  it('hook references CODEGRAPH_SERVER_URL with localhost:3000 default', async () => {
    const destPath = await makeTempDir();
    await installPostCommitHook(destPath, 'repo-1');
    const hookPath = path.join(destPath, '.git', 'hooks', 'post-commit');
    const content = await readFile(hookPath, 'utf8');
    expect(content).toContain('CODEGRAPH_SERVER_URL');
    expect(content).toContain('localhost:3000');
  });

  it('is idempotent — overwrites existing hook without error', async () => {
    const destPath = await makeTempDir();
    await installPostCommitHook(destPath, 'repo-1');
    // Call again — should not throw
    await expect(installPostCommitHook(destPath, 'repo-1')).resolves.toBeUndefined();
    // Content should reflect new repoId if changed
    await installPostCommitHook(destPath, 'repo-2');
    const hookPath = path.join(destPath, '.git', 'hooks', 'post-commit');
    const content = await readFile(hookPath, 'utf8');
    expect(content).toContain('/repos/repo-2/index?incremental=true');
  });

  it('sets the hook file to be executable (mode 0o755)', async () => {
    const destPath = await makeTempDir();
    await installPostCommitHook(destPath, 'repo-1');
    const hookPath = path.join(destPath, '.git', 'hooks', 'post-commit');
    const s = await stat(hookPath);
    // On Windows, mode bits may not be supported — skip mode check on win32
    if (process.platform !== 'win32') {
      // mode & 0o777 isolates the permission bits
      // eslint-disable-next-line no-bitwise
      const perms = s.mode & 0o777;
      expect(perms).toBe(0o755);
    } else {
      // On Windows, just verify file exists and is readable
      expect(s.isFile()).toBe(true);
    }
  });
});

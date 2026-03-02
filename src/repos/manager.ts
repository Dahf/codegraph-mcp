import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { ConfigSchema, type RepoConfig } from '../config/schema.js';
import type { RepoStore } from './store.js';

// Git URL regex — matches HTTPS and SSH git URLs (from RepoSchema)
const gitUrlRegex = /^(https?:\/\/|git@)[^\s]+$/;

/**
 * Repository CRUD manager with config.json persistence.
 *
 * Wraps a RepoStore (in-memory) and keeps config.json on disk in sync
 * whenever repos are added or removed.
 */
export class RepoManager {
  private readonly store: RepoStore;
  private readonly configPath: string;

  constructor(store: RepoStore, configPath: string) {
    this.store = store;
    this.configPath = configPath;
  }

  /**
   * List all configured repositories.
   */
  list(): RepoConfig[] {
    return this.store.getAll();
  }

  /**
   * Add a new repository.
   *
   * Validates the URL against the SSH/HTTPS regex, generates a UUID id,
   * sets addedAt to current ISO datetime, persists to config.json.
   */
  add(url: string, branch: string = 'main'): RepoConfig {
    if (!gitUrlRegex.test(url)) {
      throw new Error('Invalid git URL: must be a valid HTTPS (https://...) or SSH (git@...) URL');
    }

    const repo: RepoConfig = {
      id: randomUUID(),
      url,
      branch,
      addedAt: new Date().toISOString(),
    };

    this.store.add(repo);
    this.persistConfig();
    return repo;
  }

  /**
   * Remove a repository by ID.
   *
   * Returns true if removed, false if not found.
   * Persists the updated repos list to config.json on success.
   */
  remove(id: string): boolean {
    const removed = this.store.remove(id);
    if (removed) {
      this.persistConfig();
    }
    return removed;
  }

  /**
   * Read current config.json, update repos array from store, write back.
   * Uses JSON.stringify with 2-space indent for readable output.
   */
  private persistConfig(): void {
    let rawJson: unknown;
    try {
      const content = readFileSync(this.configPath, 'utf-8');
      rawJson = JSON.parse(content);
    } catch {
      // If config.json is unreadable, start from an empty object
      rawJson = {};
    }

    // Validate existing config to get its current shape, then overwrite repos
    const parseResult = ConfigSchema.safeParse(rawJson);
    const currentConfig = parseResult.success ? parseResult.data : {};

    const updatedConfig = {
      ...currentConfig,
      repos: this.store.toArray(),
    };

    writeFileSync(this.configPath, JSON.stringify(updatedConfig, null, 2) + '\n', 'utf-8');
  }
}

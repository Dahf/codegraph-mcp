import type { RepoConfig } from '../types/index.js';

/**
 * In-memory repository state store.
 *
 * Holds the current set of configured repositories as a Map for O(1) lookups.
 * Initialized from the repos array in config on startup.
 */
export class RepoStore {
  private repos: Map<string, RepoConfig>;

  constructor(initialRepos: RepoConfig[]) {
    this.repos = new Map(initialRepos.map((repo) => [repo.id, repo]));
  }

  /**
   * Return all repositories as an array.
   */
  getAll(): RepoConfig[] {
    return Array.from(this.repos.values());
  }

  /**
   * Return a repository by ID, or undefined if not found.
   */
  getById(id: string): RepoConfig | undefined {
    return this.repos.get(id);
  }

  /**
   * Add a repository to the store.
   */
  add(repo: RepoConfig): void {
    this.repos.set(repo.id, repo);
  }

  /**
   * Remove a repository by ID.
   * Returns true if removed, false if not found.
   */
  remove(id: string): boolean {
    return this.repos.delete(id);
  }

  /**
   * Return all repositories as an array — for serialization to config.
   */
  toArray(): RepoConfig[] {
    return Array.from(this.repos.values());
  }
}

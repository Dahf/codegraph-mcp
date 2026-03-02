import * as lancedb from '@lancedb/lancedb';
import type { Adapter } from '../types/index.js';

/**
 * Adapter for LanceDB embedded vector database.
 * LanceDB is disk-based — no separate server process is needed.
 * connect() opens the database and validates disk access with a real read.
 */
export class LanceDBAdapter implements Adapter {
  private readonly path: string;
  private db: lancedb.Connection | null = null;

  constructor(config: { path: string }) {
    this.path = config.path;
  }

  async connect(): Promise<void> {
    try {
      const db = await lancedb.connect(this.path);
      // Validate with a real disk read — isOpen() alone is not reliable (Research pitfall #4)
      await db.tableNames();
      this.db = db;
      console.log('LanceDB connection: OK');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `LanceDB initialization failed at ${this.path}. Check data directory permissions. (${msg})`
      );
    }
  }

  async healthCheck(): Promise<{ ok: boolean; message: string }> {
    if (this.db === null || !this.db.isOpen()) {
      return { ok: false, message: 'LanceDB connection not open' };
    }

    // Live disk read with 2-second timeout — NOT cached
    try {
      const tables = await Promise.race([
        this.db.tableNames(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), 2000)
        ),
      ]);
      return { ok: true, message: `LanceDB OK (${tables.length} tables)` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, message: `LanceDB health check failed: ${msg}` };
    }
  }

  async close(): Promise<void> {
    if (this.db !== null) {
      try {
        this.db.close();
      } catch {
        // Ignore errors during close
      }
      this.db = null;
      console.log('LanceDB connection closed');
    }
  }
}

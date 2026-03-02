import { createClient } from 'falkordb';
import type { Adapter } from '../types/index.js';

type FalkorDBClient = ReturnType<typeof createClient>;

/**
 * Adapter for FalkorDB (Redis with graph module).
 * Validates connectivity on connect() and exposes live health checks.
 */
export class FalkorDBAdapter implements Adapter {
  private readonly host: string;
  private readonly port: number;
  private client: FalkorDBClient | null = null;

  constructor(config: { host: string; port: number }) {
    this.host = config.host;
    this.port = config.port;
  }

  async connect(): Promise<void> {
    const client = createClient({
      socket: { host: this.host, port: this.port },
    });

    // Fail fast on connection errors instead of retrying indefinitely
    client.on('error', () => {
      // Suppress unhandled error events — we catch via connect() rejection
    });

    try {
      await client.connect();
      // Validate the connection is live with a ping
      await client.ping();
      this.client = client;
      console.log('FalkorDB connection: OK');
    } catch {
      // Clean up on failure
      try { await client.quit(); } catch { /* ignore */ }
      throw new Error(
        `FalkorDB is unreachable at ${this.host}:${this.port}. Start Redis with FalkorDB module before starting the server.`
      );
    }
  }

  async healthCheck(): Promise<{ ok: boolean; message: string }> {
    if (this.client === null) {
      return { ok: false, message: 'FalkorDB client not initialized' };
    }

    // Live check with 2-second timeout — NOT cached
    try {
      const result = await Promise.race([
        this.client.ping(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), 2000)
        ),
      ]);
      return { ok: result === 'PONG', message: `FalkorDB OK (ping: ${result})` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, message: `FalkorDB health check failed: ${msg}` };
    }
  }

  async close(): Promise<void> {
    if (this.client !== null) {
      try {
        await this.client.quit();
      } catch {
        // Ignore errors during close
      }
      this.client = null;
      console.log('FalkorDB connection closed');
    }
  }
}

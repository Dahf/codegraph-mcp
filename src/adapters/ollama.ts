import { Ollama } from 'ollama';
import type { Adapter } from '../types/index.js';

/**
 * Adapter for Ollama local model server.
 * Validates reachability on connect() via a version() call.
 * Ollama uses a stateless HTTP client — no persistent connection to manage.
 */
export class OllamaAdapter implements Adapter {
  private readonly host: string;
  private client: Ollama | null = null;

  constructor(config: { host: string }) {
    this.host = config.host;
  }

  async connect(): Promise<void> {
    const client = new Ollama({ host: this.host });
    try {
      const versionInfo = await client.version();
      this.client = client;
      console.log(`Ollama connection: OK (version: ${versionInfo.version})`);
    } catch {
      throw new Error(
        `Ollama is unreachable at ${this.host}. Start Ollama before starting the server.`
      );
    }
  }

  async healthCheck(): Promise<{ ok: boolean; message: string }> {
    if (this.client === null) {
      return { ok: false, message: 'Ollama client not initialized' };
    }

    // Live check with 2-second timeout — NOT cached
    try {
      const versionInfo = await Promise.race([
        this.client.version(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), 2000)
        ),
      ]);
      return { ok: true, message: `Ollama OK (version: ${versionInfo.version})` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, message: `Ollama health check failed: ${msg}` };
    }
  }

  /**
   * Generate embeddings for one or more text inputs.
   * @param texts - A single string or array of strings to embed
   * @param model - The Ollama model name to use (e.g. 'coderanker')
   * @returns Array of embedding vectors (one per input text)
   */
  async embed(texts: string | string[], model: string): Promise<number[][]> {
    if (this.client === null) {
      throw new Error('Ollama client not initialized -- call connect() first');
    }
    const response = await this.client.embed({ model, input: texts, truncate: true });
    return response.embeddings;
  }

  async close(): Promise<void> {
    // Ollama uses a stateless HTTP client — no persistent connection to close
    this.client = null;
    console.log('Ollama client released');
  }
}

import { EventEmitter } from 'node:events';

/**
 * Typed event map for structured indexing progress events.
 *
 * Each event key maps to a tuple of argument types (EventEmitter's convention
 * for typed overrides). All payloads include repoId for multi-repo contexts.
 */
export interface IndexProgressEvents {
  /** A source file was successfully parsed and its symbols extracted. */
  'file:parsed': [{ repoId: string; filePath: string; symbolsFound: number }];
  /** A source file was intentionally skipped — either too large or errored. */
  'file:skipped': [{ repoId: string; filePath: string; reason: 'too-large' | 'error' }];
  /** Embedding chunks were added to the background queue. */
  'embedding:queued': [{ repoId: string; chunks: number }];
  /** Memory monitor detected heap pressure above threshold — processing paused. */
  'memory:paused': [{ repoId: string; heapRatio: number }];
  /** Heap dropped below low-water mark — processing resumed. */
  'memory:resumed': [{ repoId: string }];
  /** Incremental run started — reports number of changed and deleted files to process. */
  'incremental:started': [{ repoId: string; changedFiles: number; deletedFiles: number }];
  /** Checkpoint was written to FalkorDB — captures processed file count. */
  'checkpoint:saved': [{ repoId: string; filesProcessed: number }];
  /** Pass 1 (symbol extraction) completed. */
  'pass1:complete': [{ repoId: string; filesProcessed: number; symbolsExtracted: number }];
  /** Full indexing pipeline completed. */
  'done': [{ repoId: string; filesProcessed: number; symbolsExtracted: number }];
}

/**
 * Typed EventEmitter for indexing progress events.
 *
 * Overrides `on()` and `emit()` with narrowed signatures constrained to the
 * `IndexProgressEvents` interface, giving callers full TypeScript type safety
 * on both the event name and its payload shape.
 *
 * Usage:
 * ```typescript
 * const progress = new IndexProgressEmitter();
 * progress.on('file:parsed', ({ repoId, filePath, symbolsFound }) => { ... });
 * progress.emit('file:parsed', { repoId, filePath, symbolsFound: 5 });
 * ```
 */
export class IndexProgressEmitter extends EventEmitter {
  on<K extends keyof IndexProgressEvents>(
    event: K,
    listener: (...args: IndexProgressEvents[K]) => void,
  ): this {
    return super.on(event, listener as never);
  }

  emit<K extends keyof IndexProgressEvents>(
    event: K,
    ...args: IndexProgressEvents[K]
  ): boolean {
    return super.emit(event, ...args);
  }
}

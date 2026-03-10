import v8 from 'node:v8';

/**
 * Monitors V8 heap pressure and provides a pause/resume mechanism for
 * memory-sensitive processing loops.
 *
 * When heap usage exceeds `thresholdRatio` of the V8 heap limit, the monitor
 * sets a paused flag. Callers that check `waitIfPaused()` will block until
 * the heap drops back below the low-water mark (70% of threshold).
 *
 * The internal timer uses `unref()` so it does not prevent process exit when
 * the rest of the event loop is idle (Pitfall 5 from research).
 */
export class MemoryMonitor {
  private paused = false;
  private drainResolvers: Array<() => void> = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly thresholdRatio: number = 0.80,
    private readonly intervalMs: number = 2000,
  ) {}

  /**
   * Start the periodic heap-check interval.
   * Must be called before `waitIfPaused()` is useful.
   */
  start(): void {
    this.timer = setInterval(() => {
      const { used_heap_size, heap_size_limit } = v8.getHeapStatistics();
      const ratio = used_heap_size / heap_size_limit;

      if (ratio > this.thresholdRatio && !this.paused) {
        this.paused = true;
      } else if (ratio < this.thresholdRatio * 0.70 && this.paused) {
        // Resume when heap drops to low-water mark (70% of threshold)
        this.paused = false;
        const resolvers = this.drainResolvers;
        this.drainResolvers = [];
        resolvers.forEach((r) => r());
      }
    }, this.intervalMs);

    // Prevent the timer from keeping the Node.js process alive
    this.timer.unref();
  }

  /**
   * Stop the periodic heap-check interval.
   * Also resolves any pending `waitIfPaused()` promises so callers are not
   * left hanging during shutdown.
   */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }

    // Resolve any pending drain waiters on shutdown
    const resolvers = this.drainResolvers;
    this.drainResolvers = [];
    resolvers.forEach((r) => r());
  }

  /**
   * Returns immediately if the monitor is not paused.
   * If paused, returns a Promise that resolves when the heap drops below
   * the low-water mark (or when `stop()` is called).
   */
  async waitIfPaused(): Promise<void> {
    if (!this.paused) return;
    await new Promise<void>((resolve) => {
      this.drainResolvers.push(resolve);
    });
  }

  /**
   * Returns true if the monitor is currently in a paused state.
   */
  isPaused(): boolean {
    return this.paused;
  }
}

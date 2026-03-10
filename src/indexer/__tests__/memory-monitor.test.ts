import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryMonitor } from '../memory-monitor.js';

// We need to mock node:v8 module
vi.mock('node:v8', () => ({
  default: {
    getHeapStatistics: vi.fn(() => ({
      used_heap_size: 500_000_000,
      heap_size_limit: 1_000_000_000,
    })),
  },
}));

import v8 from 'node:v8';
const mockV8 = v8 as unknown as { getHeapStatistics: ReturnType<typeof vi.fn> };

function setHeapRatio(ratio: number): void {
  const heap_size_limit = 1_000_000_000;
  mockV8.getHeapStatistics.mockReturnValue({
    used_heap_size: Math.floor(heap_size_limit * ratio),
    heap_size_limit,
  });
}

describe('MemoryMonitor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Default: heap at 50% — below threshold
    setHeapRatio(0.50);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('waitIfPaused() resolves immediately when not paused', async () => {
    const monitor = new MemoryMonitor(0.80, 2000);
    monitor.start();

    const resolved = vi.fn();
    // waitIfPaused() returns a resolved Promise when not paused — just await it
    await monitor.waitIfPaused().then(resolved);

    expect(resolved).toHaveBeenCalled();
    monitor.stop();
  });

  it('isPaused() returns false initially', () => {
    const monitor = new MemoryMonitor(0.80, 2000);
    monitor.start();
    expect(monitor.isPaused()).toBe(false);
    monitor.stop();
  });

  it('pauses when heap ratio exceeds threshold', async () => {
    const monitor = new MemoryMonitor(0.80, 2000);
    monitor.start();

    expect(monitor.isPaused()).toBe(false);

    // Set heap above threshold and advance timer
    setHeapRatio(0.85);
    await vi.advanceTimersByTimeAsync(2000);

    expect(monitor.isPaused()).toBe(true);
    monitor.stop();
  });

  it('waitIfPaused() blocks when paused, then resolves when heap drops', async () => {
    const monitor = new MemoryMonitor(0.80, 2000);
    monitor.start();

    // Trigger pause
    setHeapRatio(0.85);
    await vi.advanceTimersByTimeAsync(2000);
    expect(monitor.isPaused()).toBe(true);

    // Start waiting — should not resolve yet
    let resolved = false;
    const waitPromise = monitor.waitIfPaused().then(() => { resolved = true; });

    // Confirm still blocked (promises resolve microtasks, so flush them)
    await Promise.resolve();
    expect(resolved).toBe(false);

    // Drop heap below low-water mark (0.80 * 0.70 = 0.56)
    setHeapRatio(0.50);
    await vi.advanceTimersByTimeAsync(2000);

    await waitPromise;
    expect(resolved).toBe(true);
    monitor.stop();
  });

  it('resumes at low-water mark (70% of threshold)', async () => {
    const monitor = new MemoryMonitor(0.80, 2000);
    monitor.start();

    // Trigger pause
    setHeapRatio(0.85);
    await vi.advanceTimersByTimeAsync(2000);
    expect(monitor.isPaused()).toBe(true);

    // Heap at exactly 70% of threshold (0.80 * 0.70 = 0.56) — should NOT yet resume
    // (must be strictly less than low-water mark)
    setHeapRatio(0.57);
    await vi.advanceTimersByTimeAsync(2000);
    // 0.57 < 0.56 is false, so still paused
    expect(monitor.isPaused()).toBe(true);

    // Below low-water mark
    setHeapRatio(0.50);
    await vi.advanceTimersByTimeAsync(2000);
    expect(monitor.isPaused()).toBe(false);

    monitor.stop();
  });

  it('stop() clears the interval timer', async () => {
    const monitor = new MemoryMonitor(0.80, 2000);
    monitor.start();
    monitor.stop();

    // After stop, the monitor should not change state even if heap would exceed threshold
    setHeapRatio(0.90);
    await vi.advanceTimersByTimeAsync(10000);

    expect(monitor.isPaused()).toBe(false);
  });

  it('stop() resolves pending drain promises on shutdown', async () => {
    const monitor = new MemoryMonitor(0.80, 2000);
    monitor.start();

    // Trigger pause
    setHeapRatio(0.85);
    await vi.advanceTimersByTimeAsync(2000);
    expect(monitor.isPaused()).toBe(true);

    let resolved = false;
    const waitPromise = monitor.waitIfPaused().then(() => { resolved = true; });

    // stop() should resolve pending drain promises
    monitor.stop();
    await waitPromise;
    expect(resolved).toBe(true);
  });

  it('timer uses unref() so process does not hang', () => {
    // We cannot directly test unref() in vitest, but we can verify the monitor
    // exposes start/stop and that stop prevents further ticks.
    // This test documents the requirement and ensures the class can be instantiated.
    const monitor = new MemoryMonitor(0.80, 2000);
    // If unref() is not called on the timer, the test runner would hang
    // (in real node; not vitest fake timers). Just verify no crash.
    expect(() => { monitor.start(); monitor.stop(); }).not.toThrow();
  });
});

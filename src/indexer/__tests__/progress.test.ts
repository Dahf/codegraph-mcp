import { describe, it, expect, vi } from 'vitest';
import { IndexProgressEmitter } from '../progress.js';
import type { IndexProgressEvents } from '../progress.js';

describe('IndexProgressEmitter', () => {
  it('emitting file:parsed delivers typed payload to listener', () => {
    const emitter = new IndexProgressEmitter();
    const listener = vi.fn();

    emitter.on('file:parsed', listener);
    emitter.emit('file:parsed', { repoId: 'repo-1', filePath: 'src/index.ts', symbolsFound: 5 });

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({ repoId: 'repo-1', filePath: 'src/index.ts', symbolsFound: 5 });
  });

  it('emitting file:skipped with reason too-large delivers typed payload', () => {
    const emitter = new IndexProgressEmitter();
    const received: Array<IndexProgressEvents['file:skipped'][0]> = [];

    emitter.on('file:skipped', (payload) => { received.push(payload); });
    emitter.emit('file:skipped', { repoId: 'repo-1', filePath: 'large-file.ts', reason: 'too-large' });

    expect(received).toHaveLength(1);
    expect(received[0]?.reason).toBe('too-large');
    expect(received[0]?.filePath).toBe('large-file.ts');
  });

  it('emitting file:skipped with reason error delivers typed payload', () => {
    const emitter = new IndexProgressEmitter();
    const received: Array<IndexProgressEvents['file:skipped'][0]> = [];

    emitter.on('file:skipped', (payload) => { received.push(payload); });
    emitter.emit('file:skipped', { repoId: 'repo-1', filePath: 'broken.ts', reason: 'error' });

    expect(received[0]?.reason).toBe('error');
  });

  it('emitting done delivers final counts', () => {
    const emitter = new IndexProgressEmitter();
    const listener = vi.fn();

    emitter.on('done', listener);
    emitter.emit('done', { repoId: 'repo-1', filesProcessed: 100, symbolsExtracted: 500 });

    expect(listener).toHaveBeenCalledWith({ repoId: 'repo-1', filesProcessed: 100, symbolsExtracted: 500 });
  });

  it('emitting memory:paused delivers heap ratio', () => {
    const emitter = new IndexProgressEmitter();
    const received: Array<IndexProgressEvents['memory:paused'][0]> = [];

    emitter.on('memory:paused', (payload) => { received.push(payload); });
    emitter.emit('memory:paused', { repoId: 'repo-1', heapRatio: 0.85 });

    expect(received[0]?.heapRatio).toBe(0.85);
    expect(received[0]?.repoId).toBe('repo-1');
  });

  it('emitting memory:resumed delivers repoId', () => {
    const emitter = new IndexProgressEmitter();
    const received: Array<IndexProgressEvents['memory:resumed'][0]> = [];

    emitter.on('memory:resumed', (payload) => { received.push(payload); });
    emitter.emit('memory:resumed', { repoId: 'repo-1' });

    expect(received[0]?.repoId).toBe('repo-1');
  });

  it('emitting embedding:queued delivers chunk count', () => {
    const emitter = new IndexProgressEmitter();
    const received: Array<IndexProgressEvents['embedding:queued'][0]> = [];

    emitter.on('embedding:queued', (payload) => { received.push(payload); });
    emitter.emit('embedding:queued', { repoId: 'repo-1', chunks: 42 });

    expect(received[0]?.chunks).toBe(42);
  });

  it('emitting checkpoint:saved delivers filesProcessed count', () => {
    const emitter = new IndexProgressEmitter();
    const received: Array<IndexProgressEvents['checkpoint:saved'][0]> = [];

    emitter.on('checkpoint:saved', (payload) => { received.push(payload); });
    emitter.emit('checkpoint:saved', { repoId: 'repo-1', filesProcessed: 50 });

    expect(received[0]?.filesProcessed).toBe(50);
  });

  it('emitting pass1:complete delivers progress counters', () => {
    const emitter = new IndexProgressEmitter();
    const received: Array<IndexProgressEvents['pass1:complete'][0]> = [];

    emitter.on('pass1:complete', (payload) => { received.push(payload); });
    emitter.emit('pass1:complete', { repoId: 'repo-1', filesProcessed: 200, symbolsExtracted: 1000 });

    expect(received[0]?.filesProcessed).toBe(200);
    expect(received[0]?.symbolsExtracted).toBe(1000);
  });

  it('multiple listeners on same event all receive the payload', () => {
    const emitter = new IndexProgressEmitter();
    const listener1 = vi.fn();
    const listener2 = vi.fn();

    emitter.on('file:parsed', listener1);
    emitter.on('file:parsed', listener2);
    emitter.emit('file:parsed', { repoId: 'repo-1', filePath: 'a.ts', symbolsFound: 1 });

    expect(listener1).toHaveBeenCalledOnce();
    expect(listener2).toHaveBeenCalledOnce();
  });
});

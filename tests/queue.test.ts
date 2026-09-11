import { describe, expect, it } from 'vitest';
import { OperationQueue } from '../src/bedjet/queue';

/** A manually-resolvable operation for controlling execution order. */
function gate() {
  let release!: () => void;
  const opened = new Promise<void>((r) => (release = r));
  return { release, run: () => opened };
}

describe('OperationQueue', () => {
  it('runs operations one at a time, in order', async () => {
    const q = new OperationQueue();
    const order: number[] = [];
    const g = gate();
    const p1 = q.enqueue(async () => { order.push(1); await g.run(); });
    const p2 = q.enqueue(async () => { order.push(2); });
    await Promise.resolve();
    expect(order).toEqual([1]); // op 2 must wait for op 1
    g.release();
    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2]);
  });

  it('coalesces pending operations with the same key', async () => {
    const q = new OperationQueue();
    const ran: string[] = [];
    const g = gate();
    const blocker = q.enqueue(() => g.run()); // occupies the queue
    const first = q.enqueue(async () => { ran.push('temp=30'); }, 'temp');
    const second = q.enqueue(async () => { ran.push('temp=33'); }, 'temp');
    g.release();
    await Promise.all([blocker, first, second]);
    expect(ran).toEqual(['temp=33']); // only latest ran
  });

  it('does not coalesce an operation that is already running', async () => {
    const q = new OperationQueue();
    const ran: string[] = [];
    const g = gate();
    const running = q.enqueue(async () => { ran.push('temp=30'); await g.run(); }, 'temp');
    const queued = q.enqueue(async () => { ran.push('temp=33'); }, 'temp');
    g.release();
    await Promise.all([running, queued]);
    expect(ran).toEqual(['temp=30', 'temp=33']);
  });

  it('rejects the caller when an operation throws, and keeps draining', async () => {
    const q = new OperationQueue();
    const failing = q.enqueue(async () => { throw new Error('boom'); });
    const after = q.enqueue(async () => { /* still runs */ });
    await expect(failing).rejects.toThrow('boom');
    await expect(after).resolves.toBeUndefined();
  });
});

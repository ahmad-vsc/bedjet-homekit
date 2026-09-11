interface QueueEntry {
  run: () => Promise<void>;
  coalesceKey?: string;
  resolve: () => void;
  reject: (err: Error) => void;
}

/**
 * FIFO queue guaranteeing exactly one operation in flight — BlueZ rejects
 * overlapping GATT operations with "In Progress". Entries sharing a
 * coalesceKey collapse to the newest value while still pending.
 */
export class OperationQueue {
  private pending: QueueEntry[] = [];
  private draining = false;

  enqueue(run: () => Promise<void>, coalesceKey?: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (coalesceKey) {
        const i = this.pending.findIndex((e) => e.coalesceKey === coalesceKey);
        if (i >= 0) {
          // Superseded by a newer value for the same control: that's success.
          this.pending.splice(i, 1)[0].resolve();
        }
      }
      this.pending.push({ run, coalesceKey, resolve, reject });
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.draining) {
      return;
    }
    this.draining = true;
    try {
      while (this.pending.length > 0) {
        const entry = this.pending.shift()!;
        try {
          await entry.run();
          entry.resolve();
        } catch (err) {
          entry.reject(err as Error);
        }
      }
    } finally {
      this.draining = false;
    }
  }
}

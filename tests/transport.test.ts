// tests/transport.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BedJetTransport } from '../src/bedjet/transport';
import { FakeBleProvider } from './fakeBle';
import { makeStatusPacket } from './fixtures';

// Fake timers for backoff/watchdog, but leave microtasks/setImmediate real
// so async plumbing still flows.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

/** Lets queued promises/microtasks settle without advancing fake timers. */
async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise<void>((r) => setImmediate(r));
  }
}

function makeTransport(ble: FakeBleProvider) {
  return new BedJetTransport(ble, 'AA:BB:CC:DD:EE:FF', {
    statusTimeoutMs: 300_000,
    maxBackoffMs: 60_000,
  });
}

describe('BedJetTransport connection lifecycle', () => {
  it('connects, subscribes to status, and reaches READY', async () => {
    const ble = new FakeBleProvider();
    const t = makeTransport(ble);
    const states: string[] = [];
    t.on('state', (s: string) => states.push(s));
    t.start();
    await flush();
    expect(t.state).toBe('READY');
    expect(states).toEqual(['CONNECTING', 'SUBSCRIBING', 'READY']);
    await t.stop();
  });

  it('emits raw status notifications', async () => {
    const ble = new FakeBleProvider();
    const t = makeTransport(ble);
    const received: Buffer[] = [];
    t.on('status', (b: Buffer) => received.push(b));
    t.start();
    await flush();
    ble.current.statusChar.notify(makeStatusPacket());
    expect(received).toHaveLength(1);
    expect(received[0][1]).toBe(0x56);
    await t.stop();
  });

  it('retries with exponential backoff when connect fails', async () => {
    const ble = new FakeBleProvider();
    ble.failNextConnects = 2;
    const t = makeTransport(ble);
    t.start();
    await flush();
    expect(t.state).toBe('DISCONNECTED');

    await vi.advanceTimersByTimeAsync(1000); // first retry (fails too)
    await flush();
    expect(t.state).toBe('DISCONNECTED');

    await vi.advanceTimersByTimeAsync(1999); // just before second retry
    await flush();
    expect(t.state).toBe('DISCONNECTED');

    await vi.advanceTimersByTimeAsync(1); // second retry at 2000ms succeeds
    await flush();
    expect(t.state).toBe('READY');
    await t.stop();
  });

  it('caps backoff at maxBackoffMs', async () => {
    const ble = new FakeBleProvider();
    ble.failNextConnects = 20;
    // Huge status timeout: we fast-forward ~20 minutes below, and the silence
    // watchdog must not recycle the healthy connection mid-test.
    const t = new BedJetTransport(ble, 'AA:BB:CC:DD:EE:FF', {
      statusTimeoutMs: 10_000_000,
      maxBackoffMs: 60_000,
    });
    t.start();
    await flush();
    // Exhaust doubling: 1+2+4+8+16+32+60+60... advance far enough for all 20 failures
    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(60_000);
      await flush();
    }
    expect(t.state).toBe('READY'); // 21st attempt succeeded
    expect(ble.connections).toHaveLength(1);
    await t.stop();
  });

  it('reconnects immediately after an unsolicited disconnect', async () => {
    const ble = new FakeBleProvider();
    const t = makeTransport(ble);
    t.start();
    await flush();
    expect(t.state).toBe('READY');

    ble.current.dropConnection();
    await flush();
    expect(t.state).toBe('READY');
    expect(ble.connections).toHaveLength(2); // new connection established
    await t.stop();
  });

  it('stop() disconnects and stays down', async () => {
    const ble = new FakeBleProvider();
    const t = makeTransport(ble);
    t.start();
    await flush();
    await t.stop();
    expect(t.state).toBe('DISCONNECTED');
    expect(ble.connections[0].disconnected).toBe(true);
    await vi.advanceTimersByTimeAsync(600_000);
    await flush();
    expect(ble.connections).toHaveLength(1); // no zombie reconnects
  });

  it('stop() during an in-flight connect prevents the zombie connection from becoming READY', async () => {
    const ble = new FakeBleProvider();
    ble.manualConnect = true;
    const t = makeTransport(ble);
    const states: string[] = [];
    t.on('state', (s: string) => states.push(s));
    t.start();
    await flush();
    expect(ble.pendingConnects).toHaveLength(1); // suspended at ble.connect()

    const stopping = t.stop();
    ble.pendingConnects[0].resolve(); // connect resolves after stop() has run
    await flush();
    await stopping;

    expect(t.state).toBe('DISCONNECTED');
    expect(states).not.toContain('READY');
    expect(ble.connections).toHaveLength(1);
    expect(ble.connections[0].disconnected).toBe(true); // zombie was disconnected
  });

  it('ignores a duplicate/stale disconnect event for the same connection', async () => {
    const ble = new FakeBleProvider();
    const t = makeTransport(ble);
    t.start();
    await flush();
    expect(t.state).toBe('READY');

    ble.connections[0].dropConnection();
    ble.connections[0].dropConnection(); // stale second event for the same connection
    await flush();

    expect(ble.connections).toHaveLength(2); // exactly one reconnect
    expect(t.state).toBe('READY');
    await t.stop();
  });
});

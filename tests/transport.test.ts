// tests/transport.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BedJetTransport } from '../src/bedjet/transport';
import { FakeBleProvider, FakeConnection } from './fakeBle';
import { makeStatusPacket } from './fixtures';

// Fake timers for backoff/watchdog, but leave microtasks/setImmediate real
// so async plumbing still flows.
beforeEach(() => {
  // clearTimeout/clearInterval must be faked too, or calling them on a fake
  // timer handle (as the transport does in stop()/recycleNow()) is a silent
  // no-op against the real timer implementation, letting "cleared" timers
  // fire anyway once fake time is advanced.
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'] });
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

  it('reconnects after an unsolicited disconnect via the backoff timer', async () => {
    const ble = new FakeBleProvider();
    const t = makeTransport(ble);
    t.start();
    await flush();
    expect(t.state).toBe('READY');

    ble.current.dropConnection();
    await flush();
    expect(t.state).toBe('DISCONNECTED'); // reconnect is scheduled, not instant

    await vi.advanceTimersByTimeAsync(1000); // first backoff delay
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

  it('clears a stray reconnect timer once a superseding recycle succeeds', async () => {
    const ble = new FakeBleProvider();
    const t = makeTransport(ble);
    t.start();
    await flush();
    expect(t.state).toBe('READY');
    expect(ble.connections).toHaveLength(1);

    // An unsolicited drop schedules a 1s backoff reconnect timer.
    ble.current.dropConnection();
    await flush();
    expect(t.state).toBe('DISCONNECTED');

    // Before that timer fires, a separate recycle attempt supersedes it and
    // succeeds — e.g. write()'s retry path calling recycleNow() directly,
    // bypassing the queue the same way the real write-failure retry does.
    // Reaching into the private method models that race deterministically.
    await (t as unknown as { recycleNow(): Promise<void> }).recycleNow();
    await flush();
    expect(t.state).toBe('READY');
    expect(ble.connections).toHaveLength(2);

    // Advance past the ORIGINAL (now-stale) backoff delay. Without the fix,
    // the stray timer fires and needlessly recycles the healthy connection.
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    expect(ble.connections).toHaveLength(2); // no extra reconnect
    expect(t.state).toBe('READY');
    await t.stop();
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
    await vi.advanceTimersByTimeAsync(1000); // single scheduled reconnect
    await flush();

    expect(ble.connections).toHaveLength(2); // exactly one reconnect
    expect(t.state).toBe('READY');
    await t.stop();
  });

  it('power-cycles the adapter after repeated connect failures, then recovers', async () => {
    const ble = new FakeBleProvider();
    ble.failNextConnects = 3; // fail the first three attempts
    let resets = 0;
    const t = new BedJetTransport(ble, 'AA:BB:CC:DD:EE:FF', {
      statusTimeoutMs: 0,
      maxBackoffMs: 60_000,
      resetAdapter: async () => { resets += 1; },
    });
    t.start();
    await flush(); // attempt 1 fails
    expect(resets).toBe(0);

    await vi.advanceTimersByTimeAsync(1000); // attempt 2 fails
    await flush();
    expect(resets).toBe(0);

    await vi.advanceTimersByTimeAsync(2000); // attempt 3 fails → 3rd failure triggers reset
    await flush();
    expect(resets).toBe(1); // adapter was power-cycled

    await vi.advanceTimersByTimeAsync(4000); // attempt 4 succeeds (failNextConnects exhausted)
    await flush();
    expect(t.state).toBe('READY');
    await t.stop();
  });

  it('times out a stuck connect() and retries with backoff', async () => {
    const ble = new FakeBleProvider();
    ble.manualConnect = true;
    const t = makeTransport(ble);
    t.start();
    await flush();
    expect(ble.pendingConnects).toHaveLength(1); // suspended at ble.connect()

    await vi.advanceTimersByTimeAsync(45_000); // connect timeout fires
    await flush();
    expect(t.state).toBe('DISCONNECTED');

    ble.manualConnect = false; // let the next attempt succeed normally
    await vi.advanceTimersByTimeAsync(1000); // first backoff retry
    await flush();
    expect(t.state).toBe('READY');
    await t.stop();
  });

  it('disconnects a connection that resolves after the connect timeout fired', async () => {
    const ble = new FakeBleProvider();
    ble.manualConnect = true;
    const t = makeTransport(ble);
    const states: string[] = [];
    t.on('state', (s: string) => states.push(s));
    t.start();
    await flush();
    expect(ble.pendingConnects).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(45_000); // connect timeout fires
    await flush();
    expect(t.state).toBe('DISCONNECTED');

    // The original pending connect resolves late, after the timeout already fired.
    const lateConnection = new FakeConnection();
    ble.pendingConnects[0].resolve(lateConnection);
    await flush();

    expect(lateConnection.disconnected).toBe(true); // orphan cleaned up
    expect(states).not.toContain('READY'); // late resolution never affected state
    await t.stop();
  });

  it('stop() unblocks after a stuck connect() times out', async () => {
    const ble = new FakeBleProvider();
    ble.manualConnect = true;
    const t = makeTransport(ble);
    t.start();
    await flush();
    expect(ble.pendingConnects).toHaveLength(1);

    const stopping = t.stop();
    await vi.advanceTimersByTimeAsync(45_000); // connect timeout fires
    await flush();
    await stopping; // must resolve, not hang forever

    expect(t.state).toBe('DISCONNECTED');
  });
});

describe('BedJetTransport write path', () => {
  it('writes to the command characteristic when READY', async () => {
    const ble = new FakeBleProvider();
    const t = makeTransport(ble);
    t.start();
    await flush();
    await t.write(Buffer.from([0x01, 0x03]));
    expect([...ble.current.commandChar.writes[0]]).toEqual([0x01, 0x03]);
    await t.stop();
  });

  it('rejects fast when disconnected', async () => {
    const ble = new FakeBleProvider();
    ble.failNextConnects = 99;
    const t = makeTransport(ble);
    t.start();
    await flush();
    await expect(t.write(Buffer.from([0x01, 0x01]))).rejects.toThrow('not connected');
    await t.stop();
  });

  it('recovers from a write failure by reconnecting and retrying once', async () => {
    const ble = new FakeBleProvider();
    const t = makeTransport(ble);
    t.start();
    await flush();
    ble.current.commandChar.failNextWrites = 1; // simulates ATT error 0x0e
    await t.write(Buffer.from([0x03, 66]));
    expect(ble.connections).toHaveLength(2); // recycled
    expect([...ble.connections[1].commandChar.writes[0]]).toEqual([0x03, 66]);
    await t.stop();
  });

  it('rejects when the retry also cannot go through', async () => {
    const ble = new FakeBleProvider();
    const t = makeTransport(ble);
    t.start();
    await flush();
    ble.current.commandChar.failNextWrites = 1;
    ble.failNextConnects = 99; // reconnect will fail too
    await expect(t.write(Buffer.from([0x03, 66]))).rejects.toThrow('not connected');
    await t.stop();
  });

  it('coalesces queued writes with the same key', async () => {
    const ble = new FakeBleProvider();
    const t = makeTransport(ble);
    t.start();
    await flush();
    // Three temp writes fired in the same tick (slider drag): the first
    // enters the queue slot; the next two coalesce down to the last one.
    const writes = Promise.all([
      t.write(Buffer.from([0x03, 60]), 'temp'),
      t.write(Buffer.from([0x03, 62]), 'temp'),
      t.write(Buffer.from([0x03, 66]), 'temp'),
    ]);
    await flush();
    await writes;
    const sent = ble.current.commandChar.writes.map((w) => [...w]);
    expect(sent).toEqual([[0x03, 60], [0x03, 66]]); // middle write never sent
    await t.stop();
  });
});

describe('BedJetTransport hung-operation recovery', () => {
  it('does not wedge forever when a GATT op hangs; times out and retries', async () => {
    const ble = new FakeBleProvider();
    const t = new BedJetTransport(ble, 'AA:BB:CC:DD:EE:FF', {
      statusTimeoutMs: 300_000,
      maxBackoffMs: 60_000,
      opTimeoutMs: 20_000,
    });
    // First connection: subscribe() hangs forever (wedged D-Bus call).
    ble.connectHook = (conn) => { conn.statusChar.hangSubscribe = true; };
    t.start();
    await flush();
    expect(t.state).toBe('SUBSCRIBING'); // stuck partway through connect

    // The op timeout fires, the attempt fails, and backoff is scheduled —
    // the queue is NOT permanently blocked.
    await vi.advanceTimersByTimeAsync(20_000);
    await flush();
    expect(t.state).toBe('DISCONNECTED');

    // Next attempt has a healthy subscribe and reaches READY.
    ble.connectHook = undefined;
    await vi.advanceTimersByTimeAsync(1000); // first backoff delay
    await flush();
    expect(t.state).toBe('READY');
    await t.stop();
  });
});

describe('BedJetTransport status watchdog', () => {
  it('recycles the connection after status silence', async () => {
    const ble = new FakeBleProvider();
    const t = makeTransport(ble);
    t.start();
    await flush();
    expect(ble.connections).toHaveLength(1);
    // Watchdog ticks every 15s; first check past the 300s threshold is at 315s.
    await vi.advanceTimersByTimeAsync(320_000);
    await flush();
    expect(ble.connections).toHaveLength(2);
    expect(t.state).toBe('READY');
    await t.stop();
  });

  it('does not recycle while notifications keep arriving', async () => {
    const ble = new FakeBleProvider();
    const t = makeTransport(ble);
    t.start();
    await flush();
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(150_000);
      await flush();
      ble.connections[0].statusChar.notify(makeStatusPacket());
    }
    expect(ble.connections).toHaveLength(1); // 600s elapsed, never silent >300s
    await t.stop();
  });
});

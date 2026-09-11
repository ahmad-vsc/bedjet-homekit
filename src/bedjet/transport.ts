import { EventEmitter } from 'events';
import { BEDJET_SERVICE_UUID, COMMAND_CHAR_UUID, STATUS_CHAR_UUID } from './protocol';
import { OperationQueue } from './queue';

export interface BleCharacteristic {
  write(data: Buffer): Promise<void>;
  subscribe(onData: (data: Buffer) => void): Promise<void>;
}

export interface BleConnection {
  getCharacteristic(serviceUuid: string, charUuid: string): Promise<BleCharacteristic>;
  disconnect(): Promise<void>;
  onDisconnect(cb: () => void): void;
}

export interface BleProvider {
  connect(mac: string): Promise<BleConnection>;
}

export type TransportState = 'DISCONNECTED' | 'CONNECTING' | 'SUBSCRIBING' | 'READY';

export interface TransportOptions {
  statusTimeoutMs?: number;
  maxBackoffMs?: number;
  connectTimeoutMs?: number;
  /** Ceiling for any single post-connect GATT op (subscribe, write, disconnect). */
  opTimeoutMs?: number;
  /**
   * Optional recovery hook: power-cycle the BLE adapter. Called after several
   * consecutive connect failures to clear a wedged controller (the Pi's
   * built-in radio can get stuck under contention). Omit to disable.
   */
  resetAdapter?: () => Promise<void>;
  log?: (msg: string) => void;
}

const INITIAL_BACKOFF_MS = 1000;
const WATCHDOG_INTERVAL_MS = 15_000;
const DEFAULT_OP_TIMEOUT_MS = 20_000;
// A connection that survives this long is considered stable, so its backoff
// resets. A drop sooner than this is treated as flapping and backs off, so a
// contended/flaky radio (e.g. the Pi's built-in BLE shared with other plugins)
// is never hammered with immediate reconnects.
const MIN_STABLE_MS = 12_000;
// After this many consecutive connect failures, power-cycle the adapter (if a
// resetAdapter hook was provided) to clear a wedged controller.
const RESET_AFTER_FAILURES = 3;

/**
 * Owns the single BLE connection to a BedJet. All GATT operations are
 * serialized through one OperationQueue (BlueZ rejects overlapping ops),
 * and the connection is recycled on disconnect, write failure, or status
 * silence. Emits 'state' (TransportState) and 'status' (Buffer).
 */
export class BedJetTransport extends EventEmitter {
  private stateValue: TransportState = 'DISCONNECTED';
  private readonly queue = new OperationQueue();
  private connection: BleConnection | null = null;
  private commandChar: BleCharacteristic | null = null;
  private backoffMs = INITIAL_BACKOFF_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private lastStatusAt = 0;
  private consecutiveFailures = 0;
  private stopped = true;

  private readonly statusTimeoutMs: number;
  private readonly maxBackoffMs: number;
  private readonly connectTimeoutMs: number;
  private readonly opTimeoutMs: number;
  private readonly resetAdapter?: () => Promise<void>;
  private readonly log: (msg: string) => void;

  constructor(
    private readonly ble: BleProvider,
    private readonly mac: string,
    opts: TransportOptions = {},
  ) {
    super();
    this.statusTimeoutMs = opts.statusTimeoutMs ?? 300_000;
    this.maxBackoffMs = opts.maxBackoffMs ?? 60_000;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 45_000;
    this.opTimeoutMs = opts.opTimeoutMs ?? DEFAULT_OP_TIMEOUT_MS;
    this.resetAdapter = opts.resetAdapter;
    this.log = opts.log ?? (() => undefined);
  }

  get state(): TransportState {
    return this.stateValue;
  }

  start(): void {
    this.stopped = false;
    this.enqueueRecycle();
    // The silence watchdog is opt-in: recycling a healthy but quiet connection
    // (a BedJet that's simply off sends no status) churns the radio for no
    // reason. Real drops are caught by the disconnect handler, and a failed
    // command reconnects on its own. Enable only if statusTimeoutMs > 0.
    if (this.statusTimeoutMs > 0) {
      this.watchdog = setInterval(() => this.checkLiveness(), WATCHDOG_INTERVAL_MS);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
    // Serialize with any in-flight/pending recycleNow() so we never tear down
    // out from under a connect that's still resolving; also coalesces away
    // any still-pending recycle entry.
    await this.queue.enqueue(() => this.teardown(), 'recycle');
    this.setState('DISCONNECTED');
  }

  /**
   * Sends a command packet. Queued behind any in-flight operation and
   * coalesced by key. On write failure: one forced reconnect + retry,
   * then an honest rejection for HomeKit to surface.
   */
  write(data: Buffer, coalesceKey?: string): Promise<void> {
    return this.queue.enqueue(async () => {
      if (this.stateValue !== 'READY' || !this.commandChar) {
        throw new Error('BedJet is not connected');
      }
      try {
        await this.withTimeout(this.commandChar.write(data), 'write');
      } catch (err) {
        this.log(`write failed (${(err as Error).message}); reconnecting to retry`);
        // Already inside the queue slot, so call recycleNow directly —
        // enqueueing here would deadlock behind ourselves.
        await this.recycleNow();
        if (this.stateValue !== 'READY' || !this.commandChar) {
          throw new Error('BedJet is not connected');
        }
        await this.withTimeout(this.commandChar.write(data), 'write');
      }
    }, coalesceKey);
  }

  /** Serialized via the queue so it never overlaps an in-flight write. */
  private enqueueRecycle(): void {
    void this.queue.enqueue(() => this.recycleNow(), 'recycle').catch(() => undefined);
  }

  private async recycleNow(): Promise<void> {
    if (this.stopped) {
      return;
    }
    try {
      await this.teardown();
      this.setState('CONNECTING');
      const connection = await this.connectWithTimeout();
      if (this.stopped) {
        // stop() ran while we were suspended waiting on connect(); this
        // connection was never ours to keep. Disconnect it and bail out
        // without touching state or this.connection.
        try {
          await connection.disconnect();
        } catch {
          // Already gone — that's fine.
        }
        return;
      }
      this.connection = connection;
      connection.onDisconnect(() => this.onUnsolicitedDisconnect(connection));
      this.setState('SUBSCRIBING');
      // Every post-connect GATT call is bounded: a hung BlueZ/D-Bus op here
      // would otherwise block the single queue (and every future command)
      // forever. On timeout we reject into the catch below and retry.
      const statusChar = await this.withTimeout(
        connection.getCharacteristic(BEDJET_SERVICE_UUID, STATUS_CHAR_UUID), 'get status char');
      await this.withTimeout(
        statusChar.subscribe((data) => this.onStatus(data)), 'subscribe');
      this.commandChar = await this.withTimeout(
        connection.getCharacteristic(BEDJET_SERVICE_UUID, COMMAND_CHAR_UUID), 'get command char');
      // No initial read: the BedJet's status characteristic is notify-only, and
      // the client already presents a reachable Off state until the first
      // notification arrives (which the device sends once it's turned on).
      this.lastStatusAt = Date.now();
      // A stray timer can still be pending here if this success came from a
      // recycle that superseded an earlier failed attempt (e.g. a direct
      // recycleNow() call from write()'s retry path) — left alone, it would
      // fire later and needlessly recycle this healthy connection.
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      // Reset backoff only after the connection proves stable — not
      // immediately — so a link that drops within seconds keeps backing off
      // instead of reconnecting on a tight loop.
      if (this.stableTimer) {
        clearTimeout(this.stableTimer);
      }
      this.stableTimer = setTimeout(() => {
        this.stableTimer = null;
        if (this.stateValue === 'READY') {
          this.backoffMs = INITIAL_BACKOFF_MS;
        }
      }, MIN_STABLE_MS);
      this.consecutiveFailures = 0;
      this.setState('READY');
      this.log('connected to BedJet');
    } catch (err) {
      await this.teardown();
      this.setState('DISCONNECTED');
      if (this.stopped) {
        return;
      }
      this.consecutiveFailures++;
      this.log(
        `connect failed (${(err as Error).message}) — is the BedJet app open on your phone?`,
      );
      // Repeated failures usually mean the adapter is wedged (the Pi's built-in
      // radio does this under contention). Power-cycle it to recover.
      if (this.resetAdapter && this.consecutiveFailures % RESET_AFTER_FAILURES === 0) {
        this.log(`still failing after ${this.consecutiveFailures} tries; resetting the Bluetooth adapter`);
        try {
          await this.resetAdapter();
        } catch (resetErr) {
          this.log(`adapter reset failed: ${(resetErr as Error).message}`);
        }
        if (this.stopped) {
          return;
        }
      }
      const delay = this.backoffMs;
      this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
      this.log(`retrying in ${Math.round(delay / 1000)}s`);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.enqueueRecycle();
      }, delay);
    }
  }

  /**
   * Bounds `ble.connect()` so a stuck BlueZ/D-Bus call can never hang the
   * queue (and therefore `stop()`) forever. A connect that resolves after the
   * timeout fired is an orphan connection and gets disconnected.
   */
  private connectWithTimeout(): Promise<BleConnection> {
    return this.withTimeout(
      this.ble.connect(this.mac),
      'connect',
      this.connectTimeoutMs,
      (connection) => connection.disconnect().catch(() => undefined),
    );
  }

  /**
   * Races a BLE operation against a timeout so one wedged D-Bus call cannot
   * block the single command queue forever. On timeout the returned promise
   * rejects; the underlying op is abandoned (its late settle is swallowed, or
   * handed to `onOrphan` for cleanup — e.g. disconnecting a late connection).
   */
  private withTimeout<T>(
    op: Promise<T>,
    label: string,
    ms: number = this.opTimeoutMs,
    onOrphan?: (value: T) => void,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        reject(new Error(`${label} timed out`));
      }, ms);
      op.then(
        (value) => {
          clearTimeout(timer);
          if (settled) {
            onOrphan?.(value);
            return;
          }
          settled = true;
          resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          if (settled) {
            return;
          }
          settled = true;
          reject(err);
        },
      );
    });
  }

  private onUnsolicitedDisconnect(connection: BleConnection): void {
    // Tied to connection identity, not state: BLE stacks can fire disconnect
    // more than once for a single physical event, and a stale connection's
    // late event must not recycle a healthy newer connection.
    if (this.stopped || connection !== this.connection) {
      return;
    }
    this.connection = null;
    this.commandChar = null;
    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
    this.setState('DISCONNECTED');
    // Reconnect through the backoff timer, never instantly: a link that keeps
    // dropping (radio contention / weak signal) would otherwise flap the radio
    // and make things worse. Backoff was reset to 1s once the last connection
    // proved stable, so a healthy one-off drop still reconnects within ~1s.
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
    this.log(`BedJet disconnected; reconnecting in ${Math.round(delay / 1000)}s`);
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.enqueueRecycle();
    }, delay);
  }

  private onStatus(data: Buffer): void {
    this.lastStatusAt = Date.now();
    this.emit('status', data);
  }

  private checkLiveness(): void {
    if (this.stateValue !== 'READY') {
      return;
    }
    const silentFor = Date.now() - this.lastStatusAt;
    if (silentFor > this.statusTimeoutMs) {
      this.log(`no status for ${Math.round(silentFor / 1000)}s; recycling connection`);
      this.enqueueRecycle();
    }
  }

  private async teardown(): Promise<void> {
    this.commandChar = null;
    const connection = this.connection;
    this.connection = null;
    if (connection) {
      try {
        await this.withTimeout(connection.disconnect(), 'disconnect');
      } catch {
        // Already gone, or the disconnect itself hung past its timeout — either
        // way we drop this connection object and move on.
      }
    }
  }

  private setState(next: TransportState): void {
    if (this.stateValue !== next) {
      this.stateValue = next;
      this.emit('state', next);
    }
  }
}

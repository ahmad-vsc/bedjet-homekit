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
  log?: (msg: string) => void;
}

const INITIAL_BACKOFF_MS = 1000;
const WATCHDOG_INTERVAL_MS = 15_000;

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
  private lastStatusAt = 0;
  private stopped = true;

  private readonly statusTimeoutMs: number;
  private readonly maxBackoffMs: number;
  private readonly connectTimeoutMs: number;
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
    this.log = opts.log ?? (() => undefined);
  }

  get state(): TransportState {
    return this.stateValue;
  }

  start(): void {
    this.stopped = false;
    this.enqueueRecycle();
    this.watchdog = setInterval(() => this.checkLiveness(), WATCHDOG_INTERVAL_MS);
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
    // Serialize with any in-flight/pending recycleNow() so we never tear down
    // out from under a connect that's still resolving; also coalesces away
    // any still-pending recycle entry.
    await this.queue.enqueue(() => this.teardown(), 'recycle');
    this.setState('DISCONNECTED');
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
      const statusChar = await connection.getCharacteristic(BEDJET_SERVICE_UUID, STATUS_CHAR_UUID);
      await statusChar.subscribe((data) => this.onStatus(data));
      this.commandChar = await connection.getCharacteristic(BEDJET_SERVICE_UUID, COMMAND_CHAR_UUID);
      this.backoffMs = INITIAL_BACKOFF_MS;
      this.lastStatusAt = Date.now();
      this.setState('READY');
      this.log('connected to BedJet');
    } catch (err) {
      await this.teardown();
      this.setState('DISCONNECTED');
      if (this.stopped) {
        return;
      }
      const delay = this.backoffMs;
      this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
      this.log(
        `connect failed (${(err as Error).message}) — is the BedJet app open on your phone? ` +
        `Retrying in ${Math.round(delay / 1000)}s`,
      );
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.enqueueRecycle();
      }, delay);
    }
  }

  /**
   * Bounds `ble.connect()` so a stuck BlueZ/D-Bus call can never hang the
   * queue (and therefore `stop()`) forever — defense in depth even though
   * providers are expected to have their own timeouts. If the underlying
   * connect settles after the timeout already fired, it's an orphan: a late
   * resolve gets disconnected, a late reject is swallowed.
   */
  private connectWithTimeout(): Promise<BleConnection> {
    return new Promise<BleConnection>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        reject(new Error('connect timed out'));
      }, this.connectTimeoutMs);
      this.ble.connect(this.mac).then(
        (connection) => {
          clearTimeout(timer);
          if (settled) {
            connection.disconnect().catch(() => undefined);
            return;
          }
          settled = true;
          resolve(connection);
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
    this.log('BedJet disconnected; reconnecting');
    this.connection = null;
    this.commandChar = null;
    this.setState('DISCONNECTED');
    this.enqueueRecycle();
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
        await connection.disconnect();
      } catch {
        // Already gone — that's fine.
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

import { BleCharacteristic, BleConnection, BleProvider } from '../src/bedjet/transport';
import { STATUS_CHAR_UUID } from '../src/bedjet/protocol';

export class FakeCharacteristic implements BleCharacteristic {
  public writes: Buffer[] = [];
  public failNextWrites = 0;
  private onData: ((data: Buffer) => void) | null = null;

  async write(data: Buffer): Promise<void> {
    if (this.failNextWrites > 0) {
      this.failNextWrites--;
      throw new Error('Operation failed with ATT error: 0x0e');
    }
    this.writes.push(Buffer.from(data));
  }

  /** When true, subscribe() never resolves — models a wedged D-Bus call. */
  public hangSubscribe = false;

  async subscribe(onData: (data: Buffer) => void): Promise<void> {
    this.onData = onData;
    if (this.hangSubscribe) {
      await new Promise<void>(() => undefined); // never resolves
    }
  }

  /** Simulates the BedJet pushing a status notification. */
  notify(data: Buffer): void {
    this.onData?.(data);
  }
}

export class FakeConnection implements BleConnection {
  public statusChar = new FakeCharacteristic();
  public commandChar = new FakeCharacteristic();
  public disconnected = false;
  private disconnectCb: (() => void) | null = null;

  async getCharacteristic(_serviceUuid: string, charUuid: string): Promise<BleCharacteristic> {
    return charUuid === STATUS_CHAR_UUID ? this.statusChar : this.commandChar;
  }

  async disconnect(): Promise<void> {
    this.disconnected = true;
  }

  onDisconnect(cb: () => void): void {
    this.disconnectCb = cb;
  }

  /** Simulates BlueZ reporting an unsolicited disconnect. */
  dropConnection(): void {
    this.disconnectCb?.();
  }
}

export class FakeBleProvider implements BleProvider {
  public connections: FakeConnection[] = [];
  public failNextConnects = 0;
  /** Opt-in: connect() never resolves on its own; caller drives it via pendingConnects. */
  public manualConnect = false;
  public pendingConnects: Array<{
    resolve: (conn?: FakeConnection) => void;
    reject: (err: Error) => void;
  }> = [];
  /** Called with each freshly-created connection so a test can rig its chars. */
  public connectHook?: (conn: FakeConnection) => void;

  async connect(_mac: string): Promise<BleConnection> {
    if (this.failNextConnects > 0) {
      this.failNextConnects--;
      throw new Error('le-connection-abort-by-local');
    }
    if (this.manualConnect) {
      return new Promise<BleConnection>((resolve, reject) => {
        this.pendingConnects.push({
          resolve: (conn?: FakeConnection) => {
            const c = conn ?? new FakeConnection();
            this.connectHook?.(c);
            this.connections.push(c);
            resolve(c);
          },
          reject,
        });
      });
    }
    const conn = new FakeConnection();
    this.connectHook?.(conn);
    this.connections.push(conn);
    return conn;
  }

  get current(): FakeConnection {
    return this.connections[this.connections.length - 1];
  }
}

import { EventEmitter } from 'events';
import {
  BedJetMode, BedJetStatus, Button, buildButtonPacket, buildSetFanPacket, buildSetTempPacket,
  parseStatus, percentToFanStep,
} from './protocol';
import { TransportState } from './transport';

export type SimpleMode = 'off' | 'heat' | 'cool';

export interface BedJetSnapshot extends BedJetStatus {
  reachable: boolean;
}

/** The slice of BedJetTransport the client needs (kept small for tests). */
export interface TransportLike {
  readonly state: TransportState;
  write(data: Buffer, coalesceKey?: string): Promise<void>;
  // `(...args: any[]) => void` mirrors @types/node's own EventEmitter.on
  // listener type, so a real EventEmitter (e.g. BedJetTransport) satisfies
  // this structurally without a cast.
  on(event: string, cb: (...args: any[]) => void): unknown;
}

const DEFAULT_MIN_TEMP_C = 19;
const DEFAULT_MAX_TEMP_C = 43;

// Shown while connected but the (idle, silent) BedJet hasn't reported yet.
// It lets HomeKit render controllable Off tiles instead of "No Response";
// turning the unit on produces real notifications that replace this.
const IDLE_STATUS: BedJetStatus = {
  mode: BedJetMode.Standby,
  currentTempC: DEFAULT_MIN_TEMP_C,
  targetTempC: DEFAULT_MIN_TEMP_C,
  ambientTempC: DEFAULT_MIN_TEMP_C,
  fanStep: 0,
  minTempC: DEFAULT_MIN_TEMP_C,
  maxTempC: DEFAULT_MAX_TEMP_C,
  secondsRemaining: 0,
};

const BUTTON_FOR_MODE: Record<SimpleMode, Button> = {
  off: Button.Off,
  heat: Button.Heat,
  cool: Button.Cool,
};

/** Typed BedJet commands + last-known state. Emits 'state' (BedJetSnapshot). */
export class BedJetClient extends EventEmitter {
  private lastStatus: BedJetStatus | null = null;

  constructor(private readonly transport: TransportLike) {
    super();
    transport.on('status', (data: Buffer) => this.onStatus(data));
    transport.on('state', () => this.emitSnapshot());
  }

  get snapshot(): BedJetSnapshot | null {
    // Once we have real status, report it (with live reachability).
    if (this.lastStatus) {
      return { ...this.lastStatus, reachable: this.transport.state === 'READY' };
    }
    // Connected but the idle BedJet hasn't spoken yet: present a reachable
    // Off device so the tiles are controllable (turning it on seeds real state).
    if (this.transport.state === 'READY') {
      return { ...IDLE_STATUS, reachable: true };
    }
    // Not connected and never heard from: honestly unreachable.
    return null;
  }

  async setMode(mode: SimpleMode): Promise<void> {
    await this.transport.write(buildButtonPacket(BUTTON_FOR_MODE[mode]), 'mode');
  }

  async setTargetTemp(celsius: number): Promise<void> {
    const min = this.lastStatus?.minTempC ?? DEFAULT_MIN_TEMP_C;
    const max = this.lastStatus?.maxTempC ?? DEFAULT_MAX_TEMP_C;
    const clamped = Math.min(max, Math.max(min, celsius));
    await this.transport.write(buildSetTempPacket(clamped), 'temp');
  }

  async setFanPercent(percent: number): Promise<void> {
    await this.transport.write(buildSetFanPacket(percentToFanStep(percent)), 'fan');
  }

  private onStatus(data: Buffer): void {
    const parsed = parseStatus(data);
    if (!parsed) {
      return;
    }
    this.lastStatus = parsed;
    this.emitSnapshot();
  }

  private emitSnapshot(): void {
    const snap = this.snapshot;
    if (snap) {
      this.emit('state', snap);
    }
  }
}

import { EventEmitter } from 'events';
import {
  BedJetStatus, Button, buildButtonPacket, buildSetFanPacket, buildSetTempPacket,
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
    if (!this.lastStatus) {
      return null;
    }
    return { ...this.lastStatus, reachable: this.transport.state === 'READY' };
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

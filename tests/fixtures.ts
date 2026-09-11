import { BedJetMode } from '../src/bedjet/protocol';

export interface StatusFixture {
  mode: BedJetMode;
  actualStep: number;
  targetStep: number;
  fanStep: number;
  ambientStep: number;
  minStep: number;
  maxStep: number;
  hours: number;
  minutes: number;
  seconds: number;
}

const DEFAULTS: StatusFixture = {
  mode: BedJetMode.Heat,
  actualStep: 58, // 29°C
  targetStep: 66, // 33°C
  fanStep: 7, // 40%
  ambientStep: 52, // 26°C
  minStep: 38, // 19°C
  maxStep: 86, // 43°C
  hours: 1,
  minutes: 30,
  seconds: 0,
};

/** Builds a realistic 20-byte first-fragment V3 status notification. */
export function makeStatusPacket(overrides: Partial<StatusFixture> = {}): Buffer {
  const f = { ...DEFAULTS, ...overrides };
  const bytes = new Array<number>(20).fill(0);
  bytes[0] = 1; // is_partial (fragment 1 of 2)
  bytes[1] = 0x56; // PACKET_FORMAT_V3_HOME
  bytes[2] = 0x1f; // expected merged length
  bytes[3] = 0x01; // PACKET_TYPE_STATUS
  bytes[4] = f.hours;
  bytes[5] = f.minutes;
  bytes[6] = f.seconds;
  bytes[7] = f.actualStep;
  bytes[8] = f.targetStep;
  bytes[9] = f.mode;
  bytes[10] = f.fanStep;
  bytes[11] = 4; // max runtime hours
  bytes[12] = 0; // max runtime minutes
  bytes[13] = f.minStep;
  bytes[14] = f.maxStep;
  bytes[17] = f.ambientStep;
  return Buffer.from(bytes);
}

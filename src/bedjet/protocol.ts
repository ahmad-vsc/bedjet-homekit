// BedJet V3 BLE protocol. Constants and packet layout verified against
// ESPHome's bedjet component (esphome/components/bedjet) and pybedjet.

export const BEDJET_SERVICE_UUID = '00001000-bed0-0080-aa55-4265644a6574';
export const STATUS_CHAR_UUID = '00002000-bed0-0080-aa55-4265644a6574';
export const DEVICE_NAME_CHAR_UUID = '00002001-bed0-0080-aa55-4265644a6574';
export const COMMAND_CHAR_UUID = '00002004-bed0-0080-aa55-4265644a6574';

export enum BedJetMode {
  Standby = 0,
  Heat = 1,
  Turbo = 2,
  ExtendedHeat = 3,
  Cool = 4, // fan only
  Dry = 5,
  Wait = 6, // biorhythm pause step
}

export enum Button {
  Off = 0x1,
  Cool = 0x2,
  Heat = 0x3,
}

const CMD_BUTTON = 0x01;
const CMD_SET_TEMP = 0x03;
const CMD_SET_FAN = 0x07;

export function tempStepToCelsius(step: number): number {
  return step / 2;
}

export function celsiusToTempStep(celsius: number): number {
  return Math.round(celsius * 2);
}

export function fanStepToPercent(step: number): number {
  return 5 + 5 * step;
}

export function percentToFanStep(percent: number): number {
  return clamp(Math.round(percent / 5) - 1, 0, 19);
}

export function buildButtonPacket(button: Button): Buffer {
  return Buffer.from([CMD_BUTTON, button]);
}

export function buildSetTempPacket(celsius: number): Buffer {
  return Buffer.from([CMD_SET_TEMP, celsiusToTempStep(celsius)]);
}

export function buildSetFanPacket(step: number): Buffer {
  return Buffer.from([CMD_SET_FAN, clamp(step, 0, 19)]);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

const PACKET_FORMAT_V3_HOME = 0x56;
const PACKET_TYPE_STATUS = 0x01;

export interface BedJetStatus {
  mode: BedJetMode;
  /** Outlet air temperature — what the BedJet is blowing right now. */
  currentTempC: number;
  targetTempC: number;
  ambientTempC: number;
  fanStep: number; // 0..19
  minTempC: number;
  maxTempC: number;
  secondsRemaining: number;
}

/**
 * Parses a V3 status notification (first fragment). Returns null for
 * debug packets, short packets, or values outside the sanity window
 * (mirrors ESPHome's BedjetCodec::decode_notify validation).
 */
export function parseStatus(data: Buffer): BedJetStatus | null {
  if (data.length < 19) {
    return null;
  }
  if (data[1] !== PACKET_FORMAT_V3_HOME || data[3] !== PACKET_TYPE_STATUS) {
    return null;
  }
  const mode = data[9];
  const actual = data[7];
  const target = data[8];
  const ambient = data[17];
  const plausible =
    mode < 7 &&
    target >= 38 && target <= 86 &&
    actual > 1 && actual <= 100 &&
    ambient > 1 && ambient <= 100;
  if (!plausible) {
    return null;
  }
  return {
    mode: mode as BedJetMode,
    currentTempC: tempStepToCelsius(actual),
    targetTempC: tempStepToCelsius(target),
    ambientTempC: tempStepToCelsius(ambient),
    fanStep: data[10],
    minTempC: tempStepToCelsius(data[13]),
    maxTempC: tempStepToCelsius(data[14]),
    secondsRemaining: data[4] * 3600 + data[5] * 60 + data[6],
  };
}

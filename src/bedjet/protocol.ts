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

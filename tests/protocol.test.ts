import { describe, expect, it } from 'vitest';
import {
  buildButtonPacket, buildSetFanPacket, buildSetTempPacket, Button,
  celsiusToTempStep, fanStepToPercent, percentToFanStep, tempStepToCelsius, BedJetMode, parseStatus,
} from '../src/bedjet/protocol';
import { makeStatusPacket } from './fixtures';

describe('command packets', () => {
  it('builds a button press as [0x01, button]', () => {
    expect([...buildButtonPacket(Button.Heat)]).toEqual([0x01, 0x03]);
    expect([...buildButtonPacket(Button.Off)]).toEqual([0x01, 0x01]);
    expect([...buildButtonPacket(Button.Cool)]).toEqual([0x01, 0x02]);
  });

  it('builds set-temp as [0x03, celsius*2]', () => {
    expect([...buildSetTempPacket(33)]).toEqual([0x03, 66]);
    expect([...buildSetTempPacket(28.5)]).toEqual([0x03, 57]);
  });

  it('builds set-fan as [0x07, step] with step clamped to 0..19', () => {
    expect([...buildSetFanPacket(7)]).toEqual([0x07, 7]);
    expect([...buildSetFanPacket(25)]).toEqual([0x07, 19]);
    expect([...buildSetFanPacket(-1)]).toEqual([0x07, 0]);
  });
});

describe('conversions', () => {
  it('temp steps are half-degrees C', () => {
    expect(tempStepToCelsius(66)).toBe(33);
    expect(tempStepToCelsius(57)).toBe(28.5);
    expect(celsiusToTempStep(33)).toBe(66);
    expect(celsiusToTempStep(28.4)).toBe(57); // rounds to nearest half degree
  });

  it('fan step 0..19 maps to 5%..100%', () => {
    expect(fanStepToPercent(0)).toBe(5);
    expect(fanStepToPercent(19)).toBe(100);
    expect(percentToFanStep(5)).toBe(0);
    expect(percentToFanStep(100)).toBe(19);
    expect(percentToFanStep(42)).toBe(7); // 42% → nearest step (40%)
    expect(percentToFanStep(3)).toBe(0); // clamps low
  });
});

describe('parseStatus', () => {
  it('parses a V3 status notification', () => {
    const status = parseStatus(makeStatusPacket());
    expect(status).toEqual({
      mode: BedJetMode.Heat,
      currentTempC: 29,
      targetTempC: 33,
      ambientTempC: 26,
      fanStep: 7,
      minTempC: 19,
      maxTempC: 43,
      secondsRemaining: 5400,
    });
  });

  it('parses cool mode / different fan', () => {
    const status = parseStatus(makeStatusPacket({ mode: BedJetMode.Cool, fanStep: 19 }));
    expect(status?.mode).toBe(BedJetMode.Cool);
    expect(status?.fanStep).toBe(19);
  });

  it('rejects packets that are too short', () => {
    expect(parseStatus(makeStatusPacket().subarray(0, 10))).toBeNull();
  });

  it('rejects an 18-byte packet and parses a 19-byte packet (exact length boundary)', () => {
    expect(parseStatus(makeStatusPacket().subarray(0, 18))).toBeNull();
    expect(parseStatus(makeStatusPacket().subarray(0, 19))).toEqual({
      mode: BedJetMode.Heat,
      currentTempC: 29,
      targetTempC: 33,
      ambientTempC: 26,
      fanStep: 7,
      minTempC: 19,
      maxTempC: 43,
      secondsRemaining: 5400,
    });
  });

  it('rejects non-status packet types and formats', () => {
    const wrongFormat = makeStatusPacket();
    wrongFormat[1] = 0x05; // PACKET_FORMAT_DEBUG
    expect(parseStatus(wrongFormat)).toBeNull();

    const wrongType = makeStatusPacket();
    wrongType[3] = 0x02; // PACKET_TYPE_DEBUG
    expect(parseStatus(wrongType)).toBeNull();
  });

  it('rejects implausible values (same sanity window as ESPHome)', () => {
    expect(parseStatus(makeStatusPacket({ mode: 9 as BedJetMode }))).toBeNull();
    expect(parseStatus(makeStatusPacket({ targetStep: 20 }))).toBeNull(); // < 38
    expect(parseStatus(makeStatusPacket({ actualStep: 0 }))).toBeNull();
    expect(parseStatus(makeStatusPacket({ ambientStep: 120 }))).toBeNull();
  });
});

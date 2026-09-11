import { describe, expect, it } from 'vitest';
import { clampDisplayTemp, hcStateToSimpleMode, isRunning, modeToHCState } from '../src/accessory';
import { BedJetMode } from '../src/bedjet/protocol';

describe('mode mapping', () => {
  it('buckets BedJet modes into HomeKit Off/Heat/Cool', () => {
    expect(modeToHCState(BedJetMode.Standby)).toBe(0);
    expect(modeToHCState(BedJetMode.Wait)).toBe(0);
    expect(modeToHCState(BedJetMode.Heat)).toBe(1);
    expect(modeToHCState(BedJetMode.Turbo)).toBe(1);
    expect(modeToHCState(BedJetMode.ExtendedHeat)).toBe(1);
    expect(modeToHCState(BedJetMode.Cool)).toBe(2);
    expect(modeToHCState(BedJetMode.Dry)).toBe(2);
  });

  it('maps HomeKit target states to simple modes', () => {
    expect(hcStateToSimpleMode(0)).toBe('off');
    expect(hcStateToSimpleMode(1)).toBe('heat');
    expect(hcStateToSimpleMode(2)).toBe('cool');
  });

  it('knows which modes count as running (for the Fan tile)', () => {
    expect(isRunning(BedJetMode.Standby)).toBe(false);
    expect(isRunning(BedJetMode.Wait)).toBe(false);
    expect(isRunning(BedJetMode.Heat)).toBe(true);
    expect(isRunning(BedJetMode.Cool)).toBe(true);
  });

  it('clamps display temps into the advertised HomeKit range', () => {
    expect(clampDisplayTemp(33)).toBe(33);
    expect(clampDisplayTemp(10)).toBe(19); // BedJet cool target can sit below HomeKit min
    expect(clampDisplayTemp(50)).toBe(43);
  });
});

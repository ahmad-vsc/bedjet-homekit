import { describe, expect, it } from 'vitest';
import { PLATFORM_NAME, PLUGIN_NAME } from '../src/settings';

describe('settings', () => {
  it('exposes the platform and plugin names', () => {
    expect(PLATFORM_NAME).toBe('BedJetV3');
    expect(PLUGIN_NAME).toBe('homebridge-bedjet-v3');
  });
});

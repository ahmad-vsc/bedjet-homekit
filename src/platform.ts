// src/platform.ts — stub; replaced with the real platform in the next task.
import type { API, Characteristic, Logger, Service } from 'homebridge';

export interface BedJetPlatform {
  readonly Service: typeof Service;
  readonly Characteristic: typeof Characteristic;
  readonly log: Logger;
  readonly api: API;
}

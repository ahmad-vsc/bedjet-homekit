import type { API } from 'homebridge';
import { BedJetPlatform } from './platform';
import { PLATFORM_NAME } from './settings';

export default (api: API): void => {
  api.registerPlatform(PLATFORM_NAME, BedJetPlatform);
};

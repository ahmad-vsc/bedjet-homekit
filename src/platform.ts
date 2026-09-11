import {
  API, Characteristic, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service,
} from 'homebridge';
import { BedJetAccessory } from './accessory';
import { BedJetClient } from './bedjet/client';
import { createNodeBleProvider } from './bedjet/nodeBleProvider';
import { BedJetTransport } from './bedjet/transport';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';

const MAC_RE = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/;

interface BedJetDeviceConfig {
  name: string;
  mac: string;
}

export class BedJetPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  private readonly cachedAccessories: PlatformAccessory[] = [];
  private readonly cleanups: Array<() => Promise<void> | void> = [];

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    api.on('didFinishLaunching', () => this.startDevices());
    api.on('shutdown', () => {
      for (const cleanup of this.cleanups) {
        void cleanup();
      }
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.cachedAccessories.push(accessory);
  }

  private startDevices(): void {
    const rawDevices = this.config.devices;
    if (rawDevices !== undefined && !Array.isArray(rawDevices)) {
      this.log.error('Ignoring "devices" in config: expected an array.');
    }
    const devices = (Array.isArray(rawDevices) ? rawDevices : []) as BedJetDeviceConfig[];
    const valid: BedJetDeviceConfig[] = [];
    const seen = new Set<string>();
    for (const device of devices) {
      const label = device.name || device.mac || '(unnamed)';
      if (typeof device.mac !== 'string' || !MAC_RE.test(device.mac)) {
        this.log.error(
          `Ignoring device "${label}": "${device.mac}" is not a MAC address. ` +
          'Find yours with: npx homebridge-bedjet-v3 scan',
        );
        continue;
      }
      const mac = device.mac.toUpperCase();
      if (seen.has(mac)) {
        this.log.error(`Ignoring duplicate device entry for ${mac}`);
        continue;
      }
      seen.add(mac);
      valid.push({ name: device.name || 'BedJet', mac });
    }

    for (const device of valid) {
      const uuid = this.api.hap.uuid.generate(device.mac);
      let accessory = this.cachedAccessories.find((a) => a.UUID === uuid);
      if (!accessory) {
        this.log.info(`Adding new accessory: ${device.name} (${device.mac})`);
        accessory = new this.api.platformAccessory(device.name, uuid);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
      accessory.context.mac = device.mac;

      const provider = createNodeBleProvider();
      const transport = new BedJetTransport(provider, device.mac, {
        statusTimeoutMs: ((this.config.statusTimeoutSeconds as number) ?? 300) * 1000,
        maxBackoffMs: ((this.config.maxReconnectBackoffSeconds as number) ?? 60) * 1000,
        log: (msg) => this.log.info(`[${device.name}] ${msg}`),
      });
      const client = new BedJetClient(transport);
      new BedJetAccessory(this, accessory, client);
      transport.start();
      this.cleanups.push(async () => {
        await transport.stop();
        provider.destroy();
      });
    }

    const activeUuids = new Set(valid.map((d) => this.api.hap.uuid.generate(d.mac)));
    const stale = this.cachedAccessories.filter((a) => !activeUuids.has(a.UUID));
    if (stale.length > 0) {
      this.log.info(`Removing ${stale.length} accessory(ies) no longer in config`);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    }
  }
}

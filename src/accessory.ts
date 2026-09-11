import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import { BedJetClient, BedJetSnapshot, SimpleMode } from './bedjet/client';
import { BedJetMode, fanStepToPercent } from './bedjet/protocol';
import type { BedJetPlatform } from './platform';

// HomeKit numeric values for Current/TargetHeatingCoolingState.
const HK_OFF = 0;
const HK_HEAT = 1;
const HK_COOL = 2;

// Advertised TargetTemperature range (BedJet V3 heat range).
const HK_MIN_TEMP_C = 19;
const HK_MAX_TEMP_C = 43;

export function modeToHCState(mode: BedJetMode): 0 | 1 | 2 {
  switch (mode) {
    case BedJetMode.Heat:
    case BedJetMode.Turbo:
    case BedJetMode.ExtendedHeat:
      return HK_HEAT;
    case BedJetMode.Cool:
    case BedJetMode.Dry:
      return HK_COOL;
    default:
      return HK_OFF;
  }
}

export function hcStateToSimpleMode(state: number): SimpleMode {
  return state === HK_HEAT ? 'heat' : state === HK_COOL ? 'cool' : 'off';
}

export function isRunning(mode: BedJetMode): boolean {
  return mode !== BedJetMode.Standby && mode !== BedJetMode.Wait;
}

export function clampDisplayTemp(celsius: number): number {
  return Math.min(HK_MAX_TEMP_C, Math.max(HK_MIN_TEMP_C, celsius));
}

/** Wires one BedJet to a Thermostat + Fanv2 pair of HomeKit services. */
export class BedJetAccessory {
  private readonly thermostat: Service;
  private readonly fan: Service;

  constructor(
    private readonly platform: BedJetPlatform,
    accessory: PlatformAccessory,
    private readonly client: BedJetClient,
  ) {
    const { Service, Characteristic } = platform;

    accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'BedJet')
      .setCharacteristic(Characteristic.Model, 'BedJet V3')
      .setCharacteristic(Characteristic.SerialNumber, accessory.context.mac ?? 'unknown');

    this.thermostat =
      accessory.getService(Service.Thermostat) ?? accessory.addService(Service.Thermostat);
    this.fan = accessory.getService(Service.Fanv2) ?? accessory.addService(Service.Fanv2);

    this.thermostat.getCharacteristic(Characteristic.TargetHeatingCoolingState)
      .setProps({ validValues: [HK_OFF, HK_HEAT, HK_COOL] })
      .onGet(() => modeToHCState(this.requireSnapshot().mode))
      .onSet((value) => this.send(() => this.client.setMode(hcStateToSimpleMode(value as number))));

    this.thermostat.getCharacteristic(Characteristic.CurrentHeatingCoolingState)
      .onGet(() => modeToHCState(this.requireSnapshot().mode));

    this.thermostat.getCharacteristic(Characteristic.TargetTemperature)
      .setProps({ minValue: HK_MIN_TEMP_C, maxValue: HK_MAX_TEMP_C, minStep: 0.5 })
      .onGet(() => clampDisplayTemp(this.requireSnapshot().targetTempC))
      .onSet((value) => this.send(() => this.client.setTargetTemp(value as number)));

    this.thermostat.getCharacteristic(Characteristic.CurrentTemperature)
      .onGet(() => this.requireSnapshot().currentTempC);

    this.thermostat.getCharacteristic(Characteristic.TemperatureDisplayUnits)
      .onGet(() => Characteristic.TemperatureDisplayUnits.FAHRENHEIT)
      .onSet(() => undefined); // display units follow the phone's locale anyway

    this.fan.getCharacteristic(Characteristic.Active)
      .onGet(() => (isRunning(this.requireSnapshot().mode) ? 1 : 0))
      .onSet((value) => this.setFanActive(value));

    this.fan.getCharacteristic(Characteristic.RotationSpeed)
      .setProps({ minValue: 0, maxValue: 100, minStep: 5 })
      .onGet(() => {
        const snap = this.requireSnapshot();
        return isRunning(snap.mode) ? fanStepToPercent(snap.fanStep) : 0;
      })
      .onSet((value) => this.setFanSpeed(value));

    client.on('state', (snap: BedJetSnapshot) => this.pushState(snap));
  }

  /** Fan tile on: start fan-only Cool if the BedJet is idle. Off: BedJet off. */
  private async setFanActive(value: CharacteristicValue): Promise<void> {
    const snap = this.client.snapshot;
    if (value === 1 && (!snap || !isRunning(snap.mode))) {
      await this.send(() => this.client.setMode('cool'));
    } else if (value === 0 && (!snap || isRunning(snap.mode))) {
      await this.send(() => this.client.setMode('off'));
    }
  }

  /** Speed 0 means "off" in HomeKit's fan model; the BedJet fan can't stop while running. */
  private async setFanSpeed(value: CharacteristicValue): Promise<void> {
    const percent = value as number;
    if (percent === 0) {
      await this.send(() => this.client.setMode('off'));
    } else {
      await this.send(() => this.client.setFanPercent(percent));
    }
  }

  private requireSnapshot(): BedJetSnapshot {
    const snap = this.client.snapshot;
    if (!snap || !snap.reachable) {
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
    return snap;
  }

  private async send(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.platform.log.warn(`BedJet command failed: ${(err as Error).message}`);
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
  }

  private pushState(snap: BedJetSnapshot): void {
    if (!snap.reachable) {
      return;
    }
    const { Characteristic } = this.platform;
    this.thermostat.updateCharacteristic(
      Characteristic.CurrentHeatingCoolingState, modeToHCState(snap.mode));
    this.thermostat.updateCharacteristic(
      Characteristic.TargetHeatingCoolingState, modeToHCState(snap.mode));
    this.thermostat.updateCharacteristic(Characteristic.CurrentTemperature, snap.currentTempC);
    this.thermostat.updateCharacteristic(
      Characteristic.TargetTemperature, clampDisplayTemp(snap.targetTempC));
    this.fan.updateCharacteristic(Characteristic.Active, isRunning(snap.mode) ? 1 : 0);
    this.fan.updateCharacteristic(
      Characteristic.RotationSpeed, isRunning(snap.mode) ? fanStepToPercent(snap.fanStep) : 0);
  }
}

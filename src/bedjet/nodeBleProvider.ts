import { createBluetooth } from 'node-ble';
import { BleConnection, BleProvider } from './transport';

const WAIT_DEVICE_TIMEOUT_MS = 30_000;
const SETTLE_TIMEOUT_MS = 20_000;
const SETTLE_POLL_MS = 500;

/**
 * Resolves once the device reports connected, or rejects after `ms`.
 * node-ble types `isConnected()` as returning a string, but it resolves to a
 * boolean at runtime, so we treat the result as truthy/falsy.
 */
async function waitUntilConnected(
  device: { isConnected(): Promise<unknown> },
  ms: number,
): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await device.isConnected()) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error('connection did not settle');
    }
    await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
  }
}

/**
 * Real BleProvider backed by node-ble (BlueZ over D-Bus). Not unit tested —
 * exercised by the on-Pi verification checklist.
 *
 * Caveat: there is no cancellation primitive in the BleProvider interface, so
 * a hung connect() can only be abandoned by the transport's own timeout
 * (BedJetTransport.connectWithTimeout), never truly cancelled — the
 * adapter.waitDevice() call below keeps running at the BlueZ layer after
 * abandonment. If it later resolves, the resulting connection is an orphan
 * that wraps the same physical device as any newer session; the transport
 * disconnects orphans on late resolve, which may briefly drop a newer,
 * healthy connection to the same device. This self-heals via the transport's
 * reconnect logic.
 */
export function createNodeBleProvider(): BleProvider & { destroy(): void } {
  const { bluetooth, destroy } = createBluetooth();
  return {
    async connect(mac: string): Promise<BleConnection> {
      const adapter = await bluetooth.defaultAdapter();

      // Prefer an already-known device: on a Pi whose single radio is shared
      // with other BLE plugins, forcing discovery on every reconnect causes
      // adapter contention. Only scan if BlueZ doesn't already know the device.
      let device;
      try {
        device = await adapter.getDevice(mac);
      } catch {
        if (!(await adapter.isDiscovering())) {
          try {
            await adapter.startDiscovery();
          } catch {
            // Another process (or a previous run) already started discovery.
          }
        }
        device = await adapter.waitDevice(mac, WAIT_DEVICE_TIMEOUT_MS);
        try {
          await adapter.stopDiscovery();
        } catch {
          // Not discovering (e.g. another process already stopped it).
        }
      }

      // Reuse an existing BlueZ-level connection instead of fighting it.
      // Calling Connect() while BlueZ is already connected or mid-connect
      // throws "In Progress"; if the link is already up we skip straight to
      // GATT, and if a connect is in flight we wait for it to settle rather
      // than hammering Connect() and backing off forever.
      if (!(await device.isConnected())) {
        try {
          await device.connect();
        } catch {
          // "In Progress"/transient: let BlueZ settle, then verify state.
          await waitUntilConnected(device, SETTLE_TIMEOUT_MS);
        }
      }
      const gatt = await device.gatt();
      return {
        async getCharacteristic(serviceUuid, charUuid) {
          const service = await gatt.getPrimaryService(serviceUuid);
          const characteristic = await service.getCharacteristic(charUuid);
          return {
            // The BedJet command characteristic is write-WITHOUT-response
            // (ESPHome uses ESP_GATT_WRITE_TYPE_NO_RSP). Writing with response
            // ('request') is rejected by the device and surfaces as a spurious
            // "Not connected" error, so use 'command' (no response).
            write: (data) => characteristic.writeValue(data, { offset: 0, type: 'command' }),
            subscribe: async (onData) => {
              characteristic.on('valuechanged', onData);
              await characteristic.startNotifications();
            },
          };
        },
        async disconnect() {
          try {
            await device.disconnect();
          } catch {
            // Already disconnected.
          }
        },
        onDisconnect(cb) {
          device.on('disconnect', cb);
        },
      };
    },
    destroy,
  };
}

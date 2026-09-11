import { createBluetooth } from 'node-ble';
import { BleConnection, BleProvider } from './transport';

const WAIT_DEVICE_TIMEOUT_MS = 30_000;

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
      if (!(await adapter.isDiscovering())) {
        try {
          await adapter.startDiscovery();
        } catch {
          // Another process (or a previous run) already started discovery.
        }
      }
      const device = await adapter.waitDevice(mac, WAIT_DEVICE_TIMEOUT_MS);
      try {
        // Stop scanning once we've found the device: continuous discovery
        // shares the Pi's single BLE radio with the connection attempt and
        // degrades stability. The next reconnect calls connect() again,
        // which restarts discovery (via the isDiscovering() check above).
        await adapter.stopDiscovery();
      } catch {
        // Not discovering (e.g. another process already stopped it).
      }
      await device.connect();
      const gatt = await device.gatt();
      return {
        async getCharacteristic(serviceUuid, charUuid) {
          const service = await gatt.getPrimaryService(serviceUuid);
          const characteristic = await service.getCharacteristic(charUuid);
          return {
            // 'request' = write-with-response, so ATT errors surface to us.
            write: (data) => characteristic.writeValue(data, { offset: 0, type: 'request' }),
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

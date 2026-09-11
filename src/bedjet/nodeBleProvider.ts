import { createBluetooth } from 'node-ble';
import { BleConnection, BleProvider } from './transport';

const WAIT_DEVICE_TIMEOUT_MS = 30_000;
const DISCONNECT_TIMEOUT_MS = 8_000;
const SETTLE_POLL_MS = 400;
const RETRY_PAUSE_MS = 1_500;

// node-ble types isConnected() as string, but it resolves to a boolean at
// runtime, so results are treated as truthy/falsy throughout.
type ConnDevice = {
  isConnected(): Promise<unknown>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function withTimeout<T>(op: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    op,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(label + ' timed out')), ms)),
  ]);
}

/** Polls until the device reports disconnected, or gives up after `ms`. */
async function waitUntilDisconnected(device: ConnDevice, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (!(await device.isConnected())) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await sleep(SETTLE_POLL_MS);
  }
}

/**
 * Establishes a connection this client OWNS. A connection BlueZ set up on its
 * own (auto-connect of a trusted device) resolves GATT but rejects our writes
 * with "Not connected", so any pre-existing connection is torn down first.
 * One retry absorbs the transient BlueZ aborts ("le-connection-abort-by-local",
 * "In Progress") common on the Pi's built-in radio.
 */
async function connectOwned(device: ConnDevice): Promise<void> {
  if (await device.isConnected()) {
    try {
      await withTimeout(device.disconnect(), DISCONNECT_TIMEOUT_MS, 'disconnect');
    } catch {
      // Hung/stale disconnect — fall through and try to connect anyway.
    }
    await waitUntilDisconnected(device, DISCONNECT_TIMEOUT_MS);
  }
  try {
    await device.connect();
  } catch {
    try {
      await device.disconnect();
    } catch {
      // ignore
    }
    await sleep(RETRY_PAUSE_MS);
    await device.connect(); // let a second failure propagate to the transport
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

      // Own the connection: a BlueZ auto-connection (trusted device) resolves
      // GATT but rejects our writes with "Not connected", so tear down any
      // pre-existing link and connect fresh ourselves.
      await connectOwned(device as unknown as ConnDevice);
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

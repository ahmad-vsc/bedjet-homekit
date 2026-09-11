import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { createBluetooth } from 'node-ble';
import { BleConnection, BleProvider } from './transport';

// Absolute path avoids depending on the systemd service PATH; fall back to a
// bare PATH lookup for non-standard installs.
const BLUETOOTHCTL = existsSync('/usr/bin/bluetoothctl') ? '/usr/bin/bluetoothctl' : 'bluetoothctl';

/**
 * Power-cycles the default BLE controller via bluetoothctl (which talks to
 * BlueZ over D-Bus — permitted for the Homebridge user by the plugin's D-Bus
 * policy, no root needed). Used to recover a wedged built-in radio.
 */
export function resetBluetoothAdapter(): Promise<void> {
  const run = (args: string[]): Promise<void> =>
    new Promise((resolve) => execFile(BLUETOOTHCTL, args, { timeout: 8_000 }, () => resolve()));
  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  return run(['power', 'off'])
    .then(() => wait(2_000))
    .then(() => run(['power', 'on']))
    .then(() => wait(2_500));
}

const WAIT_DEVICE_TIMEOUT_MS = 30_000;
const DISCONNECT_TIMEOUT_MS = 8_000;
const SETTLE_POLL_MS = 400;
const RETRY_PAUSE_MS = 1_500;
// node-ble reuses one Device object per MAC and broadcasts its 'disconnect'
// event to every listener. A disconnect we trigger ourselves (teardown or the
// reconnect below) is delivered asynchronously — often a second or two later,
// after we've already reconnected — and must NOT be mistaken for the device
// dropping, or reconnect loops forever. Events within this window of a
// deliberate disconnect are treated as our own and ignored.
const DELIBERATE_DISCONNECT_GRACE_MS = 4_000;

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
async function connectOwned(device: ConnDevice, markDeliberate: () => void): Promise<void> {
  if (await device.isConnected()) {
    markDeliberate();
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
    markDeliberate();
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
  // Timestamp of the last disconnect WE initiated (teardown or reconnect).
  // Shared across connect() calls because node-ble reuses one Device per MAC.
  let deliberateDisconnectAt = 0;
  const markDeliberate = (): void => {
    deliberateDisconnectAt = Date.now();
  };
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
      await connectOwned(device as unknown as ConnDevice, markDeliberate);
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
              // Drop any listener left over from a previous connection — the
              // char object is reused per path, so they would otherwise pile up.
              characteristic.removeAllListeners('valuechanged');
              characteristic.on('valuechanged', onData);
              await characteristic.startNotifications();
            },
          };
        },
        async disconnect() {
          markDeliberate();
          try {
            await device.disconnect();
          } catch {
            // Already disconnected.
          }
        },
        onDisconnect(cb) {
          // Single listener on the shared Device; ignore self-inflicted
          // disconnects (delivered late) so reconnects don't loop.
          device.removeAllListeners('disconnect');
          device.on('disconnect', () => {
            if (Date.now() - deliberateDisconnectAt < DELIBERATE_DISCONNECT_GRACE_MS) {
              return;
            }
            cb();
          });
        },
      };
    },
    destroy,
  };
}

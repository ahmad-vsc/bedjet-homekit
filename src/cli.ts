#!/usr/bin/env node
import { createBluetooth } from 'node-ble';

const SCAN_SECONDS = 30;

async function scan(): Promise<void> {
  console.log(`Scanning for BedJets for ${SCAN_SECONDS}s (close the BedJet app on your phone first)...`);
  const { bluetooth, destroy } = createBluetooth();
  try {
    const adapter = await bluetooth.defaultAdapter();
    if (!(await adapter.isDiscovering())) {
      await adapter.startDiscovery();
    }
    const found = new Set<string>();
    const deadline = Date.now() + SCAN_SECONDS * 1000;
    while (Date.now() < deadline) {
      for (const mac of await adapter.devices()) {
        if (found.has(mac)) {
          continue;
        }
        try {
          const device = await adapter.getDevice(mac);
          const name = await device.getName();
          if (name.toUpperCase().includes('BEDJET')) {
            found.add(mac);
            console.log(`  ${mac}  ${name}`);
          }
        } catch {
          // Device advertises no name — not a BedJet.
        }
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    console.log(
      found.size > 0
        ? 'Done. Put the MAC address above into your Homebridge config.'
        : 'No BedJets found. Is it powered on, in range, and the phone app closed?',
    );
  } finally {
    destroy();
  }
}

const command = process.argv[2];
if (command === 'scan') {
  scan().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  console.log('Usage: homebridge-bedjet-v3 scan');
  process.exit(command ? 1 : 0);
}

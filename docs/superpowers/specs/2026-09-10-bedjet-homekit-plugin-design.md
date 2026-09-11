# BedJet V3 HomeKit Plugin — Design

**Date:** 2026-09-10
**Status:** Approved by user
**Replaces:** [OwenKelly05/homebridge-bedjet](https://github.com/OwenKelly05/homebridge-bedjet) (abandoned)

## Problem

The user's BedJet V3 was controlled from HomeKit via the abandoned `homebridge-bedjet`
plugin on a Raspberry Pi running Homebridge. It stopped working: accessories appear in
the Home app but commands do nothing. Homebridge logs show two BLE failures:

```
Command 0x1 failed: DBusError: In Progress
Command 0x1 failed: DBusError: Operation failed with ATT error: 0x0e
```

Root causes: (1) BLE operations issued concurrently — BlueZ rejects overlapping GATT
operations with `In Progress`; (2) writes issued into stale/half-dead connections —
the BedJet returns ATT `0x0e` (Unlikely Error) and the plugin never recovers.

## Goal

A new Homebridge platform plugin, `homebridge-bedjet-v3`, written in TypeScript,
controlling **one BedJet V3** over direct BLE (no cloud) from the existing Raspberry Pi
Homebridge, with these HomeKit features:

- On/off
- Heat / Cool mode with target temperature (Thermostat service)
- Current temperature from the BedJet's sensor
- Fan speed 0–100% (Fan service, mapped to BedJet's 20 steps of 5%)

Out of scope (deliberately, per user): Turbo/Extended-Heat/Dry modes, M1–M3 memory
presets, multiple devices (design leaves room, config is a `devices` array, but only
one is supported/tested).

## Architecture

Three layers, each independently testable:

```
Home app ──HomeKit──> Homebridge ──> [Accessory layer]  HomeKit characteristics ⇄ BedJet state
                                          │
                                     [BedJet client]    protocol: command packets, status parsing
                                          │
                                     [BLE transport]    connection state machine + command queue
```

```
src/
  index.ts           plugin registration
  platform.ts        Homebridge platform: reads config, registers accessories
  accessory.ts       Thermostat + Fan services ⇄ BedJet state mapping
  bedjet/
    client.ts        protocol: builds command packets, parses status notifications,
                     holds the BedJet state model, emits state-change events
    transport.ts     BLE via node-ble (BlueZ D-Bus): state machine + FIFO command queue
    protocol.ts      constants: UUIDs, opcodes, temperature/fan conversions
```

The accessory and client layers never touch BLE concerns; the transport never knows
about HomeKit. The transport interface is small (connect, write, subscribe, events)
so tests substitute a fake.

## BLE protocol (community-verified, from ESPHome's maintained BedJet component)

- Service UUID: `00001000-bed0-0080-aa55-4265644a6574`
- Command characteristic (write): `00002004-bed0-0080-aa55-4265644a6574`
- Status characteristic (notify): `00002000-bed0-0080-aa55-4265644a6574`
- Device name characteristic: `00002001-bed0-0080-aa55-4265644a6574`
- Commands: `0x1` button press (arg: `0x1` off, `0x2` cool, `0x3` heat),
  `0x3` set temperature, `0x7` set fan speed (20 levels, 5%–100%)
- Status notifications carry operating mode, current/target temperature, fan speed,
  and remaining runtime. The exact byte offsets are transcribed from ESPHome's
  `bedjet_codec.h` (the authoritative community source) as the first implementation
  task, and locked in with unit tests against captured example packets.

## HomeKit mapping

| HomeKit | BedJet |
|---|---|
| Thermostat `TargetHeatingCoolingState` Off/Heat/Cool | button Off / Heat / Cool |
| Thermostat `TargetTemperature` (°C) | set-temp command (device works in 0.5 °C units) |
| Thermostat `CurrentTemperature` | from status notifications |
| Fan `On` | on while BedJet is off → start Cool (fan-only); off → button Off (the fan is integral to the BedJet, so fan-off means device-off) |
| Fan `RotationSpeed` 0–100% | nearest of 20 fan steps |

State flows both ways: BedJet status notifications update HomeKit characteristics, so
changes made on the BedJet remote appear in the Home app within seconds.

`Auto` mode is not offered (BedJet has no auto mode); temperature range is clamped to
the BedJet's supported range.

## Reliability layer (the reason this rebuild exists)

**Command queue** — all BLE operations (connect, subscribe, write) pass through a
single FIFO queue; exactly one operation in flight at any time. Fixes `In Progress`.
Rapid characteristic changes (e.g. dragging the temp slider) are coalesced: only the
latest pending value per control is sent.

**Connection state machine** — `DISCONNECTED → CONNECTING → SUBSCRIBING → READY`.
Any failure returns to `DISCONNECTED` and schedules reconnect with exponential backoff
(1s → 60s cap). A connection is declared dead when:

1. BlueZ reports disconnection;
2. a write fails with an ATT/DBus error — one forced reconnect + retry, then the
   HomeKit request fails honestly (fixes silent ATT `0x0e` black holes);
3. **status silence**: no notification for 300 s (default) → connection presumed
   stale and recycled proactively. ESPHome uses the same liveness signal; the
   BedJet notifies rarely while off, so shorter timeouts would recycle healthy
   connections.

**Honest failure reporting** — commands while disconnected fail fast; HomeKit shows
the accessory as unresponsive rather than pretending success. On reconnect, status is
re-read so tiles resync.

**Single-connection caveat** — BedJet V3 accepts one BLE client. Connect failures log
a human-readable hint: "is the BedJet phone app open?"

## Configuration

```json
{
  "platform": "BedJetV3",
  "devices": [{ "name": "BedJet", "mac": "AA:BB:CC:DD:EE:FF" }]
}
```

- Ships `config.schema.json` for the Homebridge Config UI form.
- Optional advanced settings (defaulted): `statusTimeoutSeconds` (300),
  `maxReconnectBackoffSeconds` (60).
- Helper: `npx homebridge-bedjet-v3 scan` lists nearby BedJets and their MACs.

## Testing

1. **Unit tests (vitest)** with a fake transport:
   - protocol layer: packet building, status parsing, temp/fan conversions;
   - queue: overlapping HomeKit requests serialize; slider spam coalesces;
   - state machine: replay the user's real failure modes (`In Progress` mid-write,
     ATT `0x0e`, status silence) and assert recovery + honest error surfacing.
2. **On-Pi verification checklist**: on/off, temp change, fan slider, pull BedJet
   power → auto-reconnect, open the phone app → friendly error in logs, control from
   BedJet remote → Home app updates.

## Deployment

Built in this workspace; installed onto the user's Pi (local install or tarball).
Publishing to npm is a possible later step, not part of this project.

## Dependencies

- `homebridge` (peer), TypeScript, vitest
- `node-ble` (BlueZ D-Bus) for BLE on the Pi — same stack the old plugin used; our
  reliability layer addresses its sharp edges rather than avoiding the library.

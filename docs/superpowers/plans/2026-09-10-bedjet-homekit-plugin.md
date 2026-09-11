# BedJet V3 Homebridge Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Homebridge platform plugin (`homebridge-bedjet-v3`) that controls one BedJet V3 over direct Bluetooth LE with on/off, heat/cool, target temperature, and fan speed — engineered around a BLE command queue and reconnection state machine so it survives the failures that killed the old plugin.

**Architecture:** Three layers: an accessory layer mapping HomeKit Thermostat + Fanv2 characteristics to BedJet state; a protocol client that builds command packets and parses status notifications; a BLE transport owning a single-flight operation queue and a `DISCONNECTED → CONNECTING → SUBSCRIBING → READY` state machine with exponential-backoff reconnect and a status-silence watchdog. The transport talks to BlueZ through a thin injectable `BleProvider` interface (real impl: `node-ble`; tests: fakes).

**Tech Stack:** TypeScript 5 (strict, CommonJS output), Homebridge ≥ 1.8, node-ble, vitest.

**Spec:** `docs/superpowers/specs/2026-09-10-bedjet-homekit-plugin-design.md`

## Global Constraints

- Node `>=18.15.0`; Homebridge `>=1.8.0` (peer). Runs on Raspberry Pi + BlueZ.
- Runtime dependency: `node-ble` only. No cloud, no BedJet app APIs.
- Platform name `BedJetV3`; plugin/package name `homebridge-bedjet-v3`.
- BLE constants (verbatim, from ESPHome's maintained BedJet component):
  - service `00001000-bed0-0080-aa55-4265644a6574`
  - status characteristic (notify) `00002000-bed0-0080-aa55-4265644a6574`
  - device-name characteristic `00002001-bed0-0080-aa55-4265644a6574`
  - command characteristic (write) `00002004-bed0-0080-aa55-4265644a6574`
- Wire format: a command is `[opcode, ...args]` written with-response to the command
  characteristic. Opcodes: button `0x01` (args: off `0x1`, cool `0x2`, heat `0x3`),
  set-temp `0x03` (arg: `celsius * 2`), set-fan `0x07` (arg: step `0..19`).
- Temps ride as half-degree-Celsius steps (`step = 2 * °C`). Fan percent = `5 + 5 * step`.
- Defaults: `statusTimeoutSeconds` 300, `maxReconnectBackoffSeconds` 60, initial backoff 1 s.
- TDD: every behavioral change lands with a failing test first. Commit after every task.
- One device supported/tested; config is a `devices` array to leave room.

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `src/settings.ts`, `tests/smoke.test.ts`

**Interfaces:**
- Consumes: nothing (first task)
- Produces: `src/settings.ts` exporting `PLATFORM_NAME = 'BedJetV3'` and `PLUGIN_NAME = 'homebridge-bedjet-v3'`; working `npm test` (vitest) and `npm run build` (tsc → `dist/`)

- [ ] **Step 1: Create package.json**

```json
{
  "name": "homebridge-bedjet-v3",
  "version": "0.1.0",
  "description": "Homebridge plugin for BedJet V3 over Bluetooth LE (no cloud)",
  "license": "MIT",
  "main": "dist/index.js",
  "bin": { "homebridge-bedjet-v3": "dist/cli.js" },
  "engines": { "node": ">=18.15.0", "homebridge": ">=1.8.0" },
  "keywords": ["homebridge-plugin", "bedjet"],
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "prepublishOnly": "npm run build"
  },
  "dependencies": { "node-ble": "^1.11.0" },
  "devDependencies": {
    "@types/node": "^18.19.0",
    "homebridge": "^1.8.0",
    "typescript": "^5.4.0",
    "vitest": "^1.6.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "CommonJS",
    "moduleResolution": "node",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "sourceMap": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create .gitignore**

```
node_modules/
dist/
*.tgz
```

- [ ] **Step 4: Create src/settings.ts**

```ts
/** Must match the `pluginAlias` in config.schema.json and the user's config.json. */
export const PLATFORM_NAME = 'BedJetV3';

/** Must match the npm package name. */
export const PLUGIN_NAME = 'homebridge-bedjet-v3';
```

- [ ] **Step 5: Create tests/smoke.test.ts**

```ts
import { describe, expect, it } from 'vitest';
import { PLATFORM_NAME, PLUGIN_NAME } from '../src/settings';

describe('settings', () => {
  it('exposes the platform and plugin names', () => {
    expect(PLATFORM_NAME).toBe('BedJetV3');
    expect(PLUGIN_NAME).toBe('homebridge-bedjet-v3');
  });
});
```

- [ ] **Step 6: Install and verify**

Run: `npm install`
Then: `npm test` — Expected: 1 test PASSES.
Then: `npm run build` — Expected: exits 0, `dist/settings.js` exists.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json .gitignore src/settings.ts tests/smoke.test.ts
git commit -m "chore: scaffold homebridge-bedjet-v3 (TypeScript + vitest)"
```

---

### Task 2: Protocol constants, conversions, and command packets

**Files:**
- Create: `src/bedjet/protocol.ts`
- Test: `tests/protocol.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces (used by every later task):
  - `BEDJET_SERVICE_UUID`, `STATUS_CHAR_UUID`, `DEVICE_NAME_CHAR_UUID`, `COMMAND_CHAR_UUID`: `string`
  - `enum BedJetMode { Standby=0, Heat=1, Turbo=2, ExtendedHeat=3, Cool=4, Dry=5, Wait=6 }`
  - `enum Button { Off=0x1, Cool=0x2, Heat=0x3 }`
  - `buildButtonPacket(button: Button): Buffer`
  - `buildSetTempPacket(celsius: number): Buffer`
  - `buildSetFanPacket(step: number): Buffer`
  - `tempStepToCelsius(step: number): number`, `celsiusToTempStep(celsius: number): number`
  - `fanStepToPercent(step: number): number`, `percentToFanStep(percent: number): number`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/protocol.test.ts
import { describe, expect, it } from 'vitest';
import {
  buildButtonPacket, buildSetFanPacket, buildSetTempPacket, Button,
  celsiusToTempStep, fanStepToPercent, percentToFanStep, tempStepToCelsius,
} from '../src/bedjet/protocol';

describe('command packets', () => {
  it('builds a button press as [0x01, button]', () => {
    expect([...buildButtonPacket(Button.Heat)]).toEqual([0x01, 0x03]);
    expect([...buildButtonPacket(Button.Off)]).toEqual([0x01, 0x01]);
    expect([...buildButtonPacket(Button.Cool)]).toEqual([0x01, 0x02]);
  });

  it('builds set-temp as [0x03, celsius*2]', () => {
    expect([...buildSetTempPacket(33)]).toEqual([0x03, 66]);
    expect([...buildSetTempPacket(28.5)]).toEqual([0x03, 57]);
  });

  it('builds set-fan as [0x07, step] with step clamped to 0..19', () => {
    expect([...buildSetFanPacket(7)]).toEqual([0x07, 7]);
    expect([...buildSetFanPacket(25)]).toEqual([0x07, 19]);
    expect([...buildSetFanPacket(-1)]).toEqual([0x07, 0]);
  });
});

describe('conversions', () => {
  it('temp steps are half-degrees C', () => {
    expect(tempStepToCelsius(66)).toBe(33);
    expect(tempStepToCelsius(57)).toBe(28.5);
    expect(celsiusToTempStep(33)).toBe(66);
    expect(celsiusToTempStep(28.4)).toBe(57); // rounds to nearest half degree
  });

  it('fan step 0..19 maps to 5%..100%', () => {
    expect(fanStepToPercent(0)).toBe(5);
    expect(fanStepToPercent(19)).toBe(100);
    expect(percentToFanStep(5)).toBe(0);
    expect(percentToFanStep(100)).toBe(19);
    expect(percentToFanStep(42)).toBe(7); // 42% → nearest step (40%)
    expect(percentToFanStep(3)).toBe(0); // clamps low
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/protocol.test.ts`
Expected: FAIL — cannot resolve `../src/bedjet/protocol`.

- [ ] **Step 3: Implement src/bedjet/protocol.ts**

```ts
// BedJet V3 BLE protocol. Constants and packet layout verified against
// ESPHome's bedjet component (esphome/components/bedjet) and pybedjet.

export const BEDJET_SERVICE_UUID = '00001000-bed0-0080-aa55-4265644a6574';
export const STATUS_CHAR_UUID = '00002000-bed0-0080-aa55-4265644a6574';
export const DEVICE_NAME_CHAR_UUID = '00002001-bed0-0080-aa55-4265644a6574';
export const COMMAND_CHAR_UUID = '00002004-bed0-0080-aa55-4265644a6574';

export enum BedJetMode {
  Standby = 0,
  Heat = 1,
  Turbo = 2,
  ExtendedHeat = 3,
  Cool = 4, // fan only
  Dry = 5,
  Wait = 6, // biorhythm pause step
}

export enum Button {
  Off = 0x1,
  Cool = 0x2,
  Heat = 0x3,
}

const CMD_BUTTON = 0x01;
const CMD_SET_TEMP = 0x03;
const CMD_SET_FAN = 0x07;

export function tempStepToCelsius(step: number): number {
  return step / 2;
}

export function celsiusToTempStep(celsius: number): number {
  return Math.round(celsius * 2);
}

export function fanStepToPercent(step: number): number {
  return 5 + 5 * step;
}

export function percentToFanStep(percent: number): number {
  return clamp(Math.round(percent / 5) - 1, 0, 19);
}

export function buildButtonPacket(button: Button): Buffer {
  return Buffer.from([CMD_BUTTON, button]);
}

export function buildSetTempPacket(celsius: number): Buffer {
  return Buffer.from([CMD_SET_TEMP, celsiusToTempStep(celsius)]);
}

export function buildSetFanPacket(step: number): Buffer {
  return Buffer.from([CMD_SET_FAN, clamp(step, 0, 19)]);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/protocol.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add src/bedjet/protocol.ts tests/protocol.test.ts
git commit -m "feat: BedJet protocol constants, conversions, command packets"
```

---

### Task 3: Status packet parsing

**Files:**
- Modify: `src/bedjet/protocol.ts` (append)
- Create: `tests/fixtures.ts`
- Test: `tests/protocol.test.ts` (append)

**Interfaces:**
- Consumes: Task 2 exports
- Produces:
  - `interface BedJetStatus { mode: BedJetMode; currentTempC: number; targetTempC: number; ambientTempC: number; fanStep: number; minTempC: number; maxTempC: number; secondsRemaining: number; }`
  - `parseStatus(data: Buffer): BedJetStatus | null` — returns `null` for non-status/invalid packets
  - Test helper `makeStatusPacket(overrides?): Buffer` in `tests/fixtures.ts`

Byte layout of a V3 status notification (first fragment; ESPHome `BedjetStatusPacket`):
`[0]` is_partial, `[1]` format (`0x56` = V3), `[2]` expected length, `[3]` type (`0x01` = status),
`[4..6]` remaining h/m/s, `[7]` actual temp step, `[8]` target temp step, `[9]` mode,
`[10]` fan step, `[11..12]` max runtime h/m, `[13]` min temp step, `[14]` max temp step,
`[15..16]` turbo time, `[17]` ambient temp step, `[18]` shutdown reason, `[19]` end of first fragment.
Everything we need lives in bytes 0–18, so partial-packet reassembly is unnecessary.

- [ ] **Step 1: Create tests/fixtures.ts**

```ts
import { BedJetMode } from '../src/bedjet/protocol';

export interface StatusFixture {
  mode: BedJetMode;
  actualStep: number;
  targetStep: number;
  fanStep: number;
  ambientStep: number;
  minStep: number;
  maxStep: number;
  hours: number;
  minutes: number;
  seconds: number;
}

const DEFAULTS: StatusFixture = {
  mode: BedJetMode.Heat,
  actualStep: 58, // 29°C
  targetStep: 66, // 33°C
  fanStep: 7, // 40%
  ambientStep: 52, // 26°C
  minStep: 38, // 19°C
  maxStep: 86, // 43°C
  hours: 1,
  minutes: 30,
  seconds: 0,
};

/** Builds a realistic 20-byte first-fragment V3 status notification. */
export function makeStatusPacket(overrides: Partial<StatusFixture> = {}): Buffer {
  const f = { ...DEFAULTS, ...overrides };
  const bytes = new Array<number>(20).fill(0);
  bytes[0] = 1; // is_partial (fragment 1 of 2)
  bytes[1] = 0x56; // PACKET_FORMAT_V3_HOME
  bytes[2] = 0x1f; // expected merged length
  bytes[3] = 0x01; // PACKET_TYPE_STATUS
  bytes[4] = f.hours;
  bytes[5] = f.minutes;
  bytes[6] = f.seconds;
  bytes[7] = f.actualStep;
  bytes[8] = f.targetStep;
  bytes[9] = f.mode;
  bytes[10] = f.fanStep;
  bytes[11] = 4; // max runtime hours
  bytes[12] = 0; // max runtime minutes
  bytes[13] = f.minStep;
  bytes[14] = f.maxStep;
  bytes[17] = f.ambientStep;
  return Buffer.from(bytes);
}
```

- [ ] **Step 2: Append failing tests to tests/protocol.test.ts**

```ts
import { BedJetMode, parseStatus } from '../src/bedjet/protocol';
import { makeStatusPacket } from './fixtures';

describe('parseStatus', () => {
  it('parses a V3 status notification', () => {
    const status = parseStatus(makeStatusPacket());
    expect(status).toEqual({
      mode: BedJetMode.Heat,
      currentTempC: 29,
      targetTempC: 33,
      ambientTempC: 26,
      fanStep: 7,
      minTempC: 19,
      maxTempC: 43,
      secondsRemaining: 5400,
    });
  });

  it('parses cool mode / different fan', () => {
    const status = parseStatus(makeStatusPacket({ mode: BedJetMode.Cool, fanStep: 19 }));
    expect(status?.mode).toBe(BedJetMode.Cool);
    expect(status?.fanStep).toBe(19);
  });

  it('rejects packets that are too short', () => {
    expect(parseStatus(makeStatusPacket().subarray(0, 10))).toBeNull();
  });

  it('rejects non-status packet types and formats', () => {
    const wrongFormat = makeStatusPacket();
    wrongFormat[1] = 0x05; // PACKET_FORMAT_DEBUG
    expect(parseStatus(wrongFormat)).toBeNull();

    const wrongType = makeStatusPacket();
    wrongType[3] = 0x02; // PACKET_TYPE_DEBUG
    expect(parseStatus(wrongType)).toBeNull();
  });

  it('rejects implausible values (same sanity window as ESPHome)', () => {
    expect(parseStatus(makeStatusPacket({ mode: 9 as BedJetMode }))).toBeNull();
    expect(parseStatus(makeStatusPacket({ targetStep: 20 }))).toBeNull(); // < 38
    expect(parseStatus(makeStatusPacket({ actualStep: 0 }))).toBeNull();
    expect(parseStatus(makeStatusPacket({ ambientStep: 120 }))).toBeNull();
  });
});
```

- [ ] **Step 3: Run tests to verify the new ones fail**

Run: `npx vitest run tests/protocol.test.ts`
Expected: FAIL — `parseStatus` is not exported.

- [ ] **Step 4: Append implementation to src/bedjet/protocol.ts**

```ts
const PACKET_FORMAT_V3_HOME = 0x56;
const PACKET_TYPE_STATUS = 0x01;

export interface BedJetStatus {
  mode: BedJetMode;
  /** Outlet air temperature — what the BedJet is blowing right now. */
  currentTempC: number;
  targetTempC: number;
  ambientTempC: number;
  fanStep: number; // 0..19
  minTempC: number;
  maxTempC: number;
  secondsRemaining: number;
}

/**
 * Parses a V3 status notification (first fragment). Returns null for
 * debug packets, short packets, or values outside the sanity window
 * (mirrors ESPHome's BedjetCodec::decode_notify validation).
 */
export function parseStatus(data: Buffer): BedJetStatus | null {
  if (data.length < 19) {
    return null;
  }
  if (data[1] !== PACKET_FORMAT_V3_HOME || data[3] !== PACKET_TYPE_STATUS) {
    return null;
  }
  const mode = data[9];
  const actual = data[7];
  const target = data[8];
  const ambient = data[17];
  const plausible =
    mode < 7 &&
    target >= 38 && target <= 86 &&
    actual > 1 && actual <= 100 &&
    ambient > 1 && ambient <= 100;
  if (!plausible) {
    return null;
  }
  return {
    mode: mode as BedJetMode,
    currentTempC: tempStepToCelsius(actual),
    targetTempC: tempStepToCelsius(target),
    ambientTempC: tempStepToCelsius(ambient),
    fanStep: data[10],
    minTempC: tempStepToCelsius(data[13]),
    maxTempC: tempStepToCelsius(data[14]),
    secondsRemaining: data[4] * 3600 + data[5] * 60 + data[6],
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/protocol.test.ts`
Expected: PASS (all).

- [ ] **Step 6: Commit**

```bash
git add src/bedjet/protocol.ts tests/protocol.test.ts tests/fixtures.ts
git commit -m "feat: parse BedJet V3 status notifications"
```

---

### Task 4: Operation queue with coalescing

**Files:**
- Create: `src/bedjet/queue.ts`
- Test: `tests/queue.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `class OperationQueue` with `enqueue(run: () => Promise<void>, coalesceKey?: string): Promise<void>`
  - Guarantee: at most one `run` executing at any time, FIFO order.
  - Coalescing: a new entry with the same `coalesceKey` as a *pending* (not yet started) entry replaces it; the superseded entry's promise **resolves** (being replaced by a newer value is success, not failure — HomeKit set handlers must not log spurious errors).

- [ ] **Step 1: Write the failing tests**

```ts
// tests/queue.test.ts
import { describe, expect, it } from 'vitest';
import { OperationQueue } from '../src/bedjet/queue';

/** A manually-resolvable operation for controlling execution order. */
function gate() {
  let release!: () => void;
  const opened = new Promise<void>((r) => (release = r));
  return { release, run: () => opened };
}

describe('OperationQueue', () => {
  it('runs operations one at a time, in order', async () => {
    const q = new OperationQueue();
    const order: number[] = [];
    const g = gate();
    const p1 = q.enqueue(async () => { order.push(1); await g.run(); });
    const p2 = q.enqueue(async () => { order.push(2); });
    await Promise.resolve();
    expect(order).toEqual([1]); // op 2 must wait for op 1
    g.release();
    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2]);
  });

  it('coalesces pending operations with the same key', async () => {
    const q = new OperationQueue();
    const ran: string[] = [];
    const g = gate();
    const blocker = q.enqueue(() => g.run()); // occupies the queue
    const first = q.enqueue(async () => { ran.push('temp=30'); }, 'temp');
    const second = q.enqueue(async () => { ran.push('temp=33'); }, 'temp');
    g.release();
    await Promise.all([blocker, first, second]);
    expect(ran).toEqual(['temp=33']); // only latest ran
  });

  it('does not coalesce an operation that is already running', async () => {
    const q = new OperationQueue();
    const ran: string[] = [];
    const g = gate();
    const running = q.enqueue(async () => { ran.push('temp=30'); await g.run(); }, 'temp');
    const queued = q.enqueue(async () => { ran.push('temp=33'); }, 'temp');
    g.release();
    await Promise.all([running, queued]);
    expect(ran).toEqual(['temp=30', 'temp=33']);
  });

  it('rejects the caller when an operation throws, and keeps draining', async () => {
    const q = new OperationQueue();
    const failing = q.enqueue(async () => { throw new Error('boom'); });
    const after = q.enqueue(async () => { /* still runs */ });
    await expect(failing).rejects.toThrow('boom');
    await expect(after).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/queue.test.ts`
Expected: FAIL — cannot resolve `../src/bedjet/queue`.

- [ ] **Step 3: Implement src/bedjet/queue.ts**

```ts
interface QueueEntry {
  run: () => Promise<void>;
  coalesceKey?: string;
  resolve: () => void;
  reject: (err: Error) => void;
}

/**
 * FIFO queue guaranteeing exactly one operation in flight — BlueZ rejects
 * overlapping GATT operations with "In Progress". Entries sharing a
 * coalesceKey collapse to the newest value while still pending.
 */
export class OperationQueue {
  private pending: QueueEntry[] = [];
  private draining = false;

  enqueue(run: () => Promise<void>, coalesceKey?: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (coalesceKey) {
        const i = this.pending.findIndex((e) => e.coalesceKey === coalesceKey);
        if (i >= 0) {
          // Superseded by a newer value for the same control: that's success.
          this.pending.splice(i, 1)[0].resolve();
        }
      }
      this.pending.push({ run, coalesceKey, resolve, reject });
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.draining) {
      return;
    }
    this.draining = true;
    try {
      while (this.pending.length > 0) {
        const entry = this.pending.shift()!;
        try {
          await entry.run();
          entry.resolve();
        } catch (err) {
          entry.reject(err as Error);
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/queue.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/bedjet/queue.ts tests/queue.test.ts
git commit -m "feat: single-flight operation queue with coalescing"
```

---

### Task 5: Transport — connect, subscribe, reconnect with backoff

**Files:**
- Create: `src/bedjet/transport.ts`, `tests/fakeBle.ts`
- Test: `tests/transport.test.ts`

**Interfaces:**
- Consumes: `OperationQueue` (Task 4); UUID constants (Task 2)
- Produces (Task 6 extends this file; Tasks 7/9 consume):
  - `interface BleCharacteristic { write(data: Buffer): Promise<void>; subscribe(onData: (data: Buffer) => void): Promise<void>; }`
  - `interface BleConnection { getCharacteristic(serviceUuid: string, charUuid: string): Promise<BleCharacteristic>; disconnect(): Promise<void>; onDisconnect(cb: () => void): void; }`
  - `interface BleProvider { connect(mac: string): Promise<BleConnection>; }`
  - `type TransportState = 'DISCONNECTED' | 'CONNECTING' | 'SUBSCRIBING' | 'READY'`
  - `interface TransportOptions { statusTimeoutMs?: number; maxBackoffMs?: number; log?: (msg: string) => void; }`
  - `class BedJetTransport extends EventEmitter` with `constructor(ble: BleProvider, mac: string, opts?: TransportOptions)`, `start(): void`, `stop(): Promise<void>`, `get state(): TransportState`. Events: `'state'` (TransportState), `'status'` (Buffer — raw notification).
  - Reconnect: initial backoff 1000 ms, doubling to `maxBackoffMs` (default 60000); reset to 1000 on successful connect. Unsolicited disconnects reconnect immediately.
  - Test fakes in `tests/fakeBle.ts`: `FakeBleProvider`, `FakeConnection`, `FakeCharacteristic` (full code below).

- [ ] **Step 1: Create tests/fakeBle.ts**

```ts
import { BleCharacteristic, BleConnection, BleProvider } from '../src/bedjet/transport';
import { STATUS_CHAR_UUID } from '../src/bedjet/protocol';

export class FakeCharacteristic implements BleCharacteristic {
  public writes: Buffer[] = [];
  public failNextWrites = 0;
  private onData: ((data: Buffer) => void) | null = null;

  async write(data: Buffer): Promise<void> {
    if (this.failNextWrites > 0) {
      this.failNextWrites--;
      throw new Error('Operation failed with ATT error: 0x0e');
    }
    this.writes.push(Buffer.from(data));
  }

  async subscribe(onData: (data: Buffer) => void): Promise<void> {
    this.onData = onData;
  }

  /** Simulates the BedJet pushing a status notification. */
  notify(data: Buffer): void {
    this.onData?.(data);
  }
}

export class FakeConnection implements BleConnection {
  public statusChar = new FakeCharacteristic();
  public commandChar = new FakeCharacteristic();
  public disconnected = false;
  private disconnectCb: (() => void) | null = null;

  async getCharacteristic(_serviceUuid: string, charUuid: string): Promise<BleCharacteristic> {
    return charUuid === STATUS_CHAR_UUID ? this.statusChar : this.commandChar;
  }

  async disconnect(): Promise<void> {
    this.disconnected = true;
  }

  onDisconnect(cb: () => void): void {
    this.disconnectCb = cb;
  }

  /** Simulates BlueZ reporting an unsolicited disconnect. */
  dropConnection(): void {
    this.disconnectCb?.();
  }
}

export class FakeBleProvider implements BleProvider {
  public connections: FakeConnection[] = [];
  public failNextConnects = 0;

  async connect(_mac: string): Promise<BleConnection> {
    if (this.failNextConnects > 0) {
      this.failNextConnects--;
      throw new Error('le-connection-abort-by-local');
    }
    const conn = new FakeConnection();
    this.connections.push(conn);
    return conn;
  }

  get current(): FakeConnection {
    return this.connections[this.connections.length - 1];
  }
}
```

- [ ] **Step 2: Write the failing tests**

```ts
// tests/transport.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BedJetTransport } from '../src/bedjet/transport';
import { FakeBleProvider } from './fakeBle';
import { makeStatusPacket } from './fixtures';

// Fake timers for backoff/watchdog, but leave microtasks/setImmediate real
// so async plumbing still flows.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

/** Lets queued promises/microtasks settle without advancing fake timers. */
async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise<void>((r) => setImmediate(r));
  }
}

function makeTransport(ble: FakeBleProvider) {
  return new BedJetTransport(ble, 'AA:BB:CC:DD:EE:FF', {
    statusTimeoutMs: 300_000,
    maxBackoffMs: 60_000,
  });
}

describe('BedJetTransport connection lifecycle', () => {
  it('connects, subscribes to status, and reaches READY', async () => {
    const ble = new FakeBleProvider();
    const t = makeTransport(ble);
    const states: string[] = [];
    t.on('state', (s: string) => states.push(s));
    t.start();
    await flush();
    expect(t.state).toBe('READY');
    expect(states).toEqual(['CONNECTING', 'SUBSCRIBING', 'READY']);
    await t.stop();
  });

  it('emits raw status notifications', async () => {
    const ble = new FakeBleProvider();
    const t = makeTransport(ble);
    const received: Buffer[] = [];
    t.on('status', (b: Buffer) => received.push(b));
    t.start();
    await flush();
    ble.current.statusChar.notify(makeStatusPacket());
    expect(received).toHaveLength(1);
    expect(received[0][1]).toBe(0x56);
    await t.stop();
  });

  it('retries with exponential backoff when connect fails', async () => {
    const ble = new FakeBleProvider();
    ble.failNextConnects = 2;
    const t = makeTransport(ble);
    t.start();
    await flush();
    expect(t.state).toBe('DISCONNECTED');

    await vi.advanceTimersByTimeAsync(1000); // first retry (fails too)
    await flush();
    expect(t.state).toBe('DISCONNECTED');

    await vi.advanceTimersByTimeAsync(1999); // just before second retry
    await flush();
    expect(t.state).toBe('DISCONNECTED');

    await vi.advanceTimersByTimeAsync(1); // second retry at 2000ms succeeds
    await flush();
    expect(t.state).toBe('READY');
    await t.stop();
  });

  it('caps backoff at maxBackoffMs', async () => {
    const ble = new FakeBleProvider();
    ble.failNextConnects = 20;
    // Huge status timeout: we fast-forward ~20 minutes below, and the silence
    // watchdog must not recycle the healthy connection mid-test.
    const t = new BedJetTransport(ble, 'AA:BB:CC:DD:EE:FF', {
      statusTimeoutMs: 10_000_000,
      maxBackoffMs: 60_000,
    });
    t.start();
    await flush();
    // Exhaust doubling: 1+2+4+8+16+32+60+60... advance far enough for all 20 failures
    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(60_000);
      await flush();
    }
    expect(t.state).toBe('READY'); // 21st attempt succeeded
    expect(ble.connections).toHaveLength(1);
    await t.stop();
  });

  it('reconnects immediately after an unsolicited disconnect', async () => {
    const ble = new FakeBleProvider();
    const t = makeTransport(ble);
    t.start();
    await flush();
    expect(t.state).toBe('READY');

    ble.current.dropConnection();
    await flush();
    expect(t.state).toBe('READY');
    expect(ble.connections).toHaveLength(2); // new connection established
    await t.stop();
  });

  it('stop() disconnects and stays down', async () => {
    const ble = new FakeBleProvider();
    const t = makeTransport(ble);
    t.start();
    await flush();
    await t.stop();
    expect(t.state).toBe('DISCONNECTED');
    expect(ble.connections[0].disconnected).toBe(true);
    await vi.advanceTimersByTimeAsync(600_000);
    await flush();
    expect(ble.connections).toHaveLength(1); // no zombie reconnects
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/transport.test.ts`
Expected: FAIL — cannot resolve `../src/bedjet/transport`.

- [ ] **Step 4: Implement src/bedjet/transport.ts**

```ts
import { EventEmitter } from 'events';
import { BEDJET_SERVICE_UUID, COMMAND_CHAR_UUID, STATUS_CHAR_UUID } from './protocol';
import { OperationQueue } from './queue';

export interface BleCharacteristic {
  write(data: Buffer): Promise<void>;
  subscribe(onData: (data: Buffer) => void): Promise<void>;
}

export interface BleConnection {
  getCharacteristic(serviceUuid: string, charUuid: string): Promise<BleCharacteristic>;
  disconnect(): Promise<void>;
  onDisconnect(cb: () => void): void;
}

export interface BleProvider {
  connect(mac: string): Promise<BleConnection>;
}

export type TransportState = 'DISCONNECTED' | 'CONNECTING' | 'SUBSCRIBING' | 'READY';

export interface TransportOptions {
  statusTimeoutMs?: number;
  maxBackoffMs?: number;
  log?: (msg: string) => void;
}

const INITIAL_BACKOFF_MS = 1000;
const WATCHDOG_INTERVAL_MS = 15_000;

/**
 * Owns the single BLE connection to a BedJet. All GATT operations are
 * serialized through one OperationQueue (BlueZ rejects overlapping ops),
 * and the connection is recycled on disconnect, write failure, or status
 * silence. Emits 'state' (TransportState) and 'status' (Buffer).
 */
export class BedJetTransport extends EventEmitter {
  private stateValue: TransportState = 'DISCONNECTED';
  private readonly queue = new OperationQueue();
  private connection: BleConnection | null = null;
  private commandChar: BleCharacteristic | null = null;
  private backoffMs = INITIAL_BACKOFF_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private lastStatusAt = 0;
  private stopped = true;

  private readonly statusTimeoutMs: number;
  private readonly maxBackoffMs: number;
  private readonly log: (msg: string) => void;

  constructor(
    private readonly ble: BleProvider,
    private readonly mac: string,
    opts: TransportOptions = {},
  ) {
    super();
    this.statusTimeoutMs = opts.statusTimeoutMs ?? 300_000;
    this.maxBackoffMs = opts.maxBackoffMs ?? 60_000;
    this.log = opts.log ?? (() => undefined);
  }

  get state(): TransportState {
    return this.stateValue;
  }

  start(): void {
    this.stopped = false;
    this.enqueueRecycle();
    this.watchdog = setInterval(() => this.checkLiveness(), WATCHDOG_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
    await this.teardown();
    this.setState('DISCONNECTED');
  }

  /** Serialized via the queue so it never overlaps an in-flight write. */
  private enqueueRecycle(): void {
    void this.queue.enqueue(() => this.recycleNow(), 'recycle').catch(() => undefined);
  }

  private async recycleNow(): Promise<void> {
    if (this.stopped) {
      return;
    }
    await this.teardown();
    this.setState('CONNECTING');
    try {
      const connection = await this.ble.connect(this.mac);
      this.connection = connection;
      connection.onDisconnect(() => this.onUnsolicitedDisconnect());
      this.setState('SUBSCRIBING');
      const statusChar = await connection.getCharacteristic(BEDJET_SERVICE_UUID, STATUS_CHAR_UUID);
      await statusChar.subscribe((data) => this.onStatus(data));
      this.commandChar = await connection.getCharacteristic(BEDJET_SERVICE_UUID, COMMAND_CHAR_UUID);
      this.backoffMs = INITIAL_BACKOFF_MS;
      this.lastStatusAt = Date.now();
      this.setState('READY');
      this.log('connected to BedJet');
    } catch (err) {
      await this.teardown();
      this.setState('DISCONNECTED');
      if (this.stopped) {
        return;
      }
      const delay = this.backoffMs;
      this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
      this.log(
        `connect failed (${(err as Error).message}) — is the BedJet app open on your phone? ` +
        `Retrying in ${Math.round(delay / 1000)}s`,
      );
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.enqueueRecycle();
      }, delay);
    }
  }

  private onUnsolicitedDisconnect(): void {
    if (this.stopped || this.stateValue === 'CONNECTING') {
      return;
    }
    this.log('BedJet disconnected; reconnecting');
    this.commandChar = null;
    this.setState('DISCONNECTED');
    this.enqueueRecycle();
  }

  private onStatus(data: Buffer): void {
    this.lastStatusAt = Date.now();
    this.emit('status', data);
  }

  private checkLiveness(): void {
    if (this.stateValue !== 'READY') {
      return;
    }
    const silentFor = Date.now() - this.lastStatusAt;
    if (silentFor > this.statusTimeoutMs) {
      this.log(`no status for ${Math.round(silentFor / 1000)}s; recycling connection`);
      this.enqueueRecycle();
    }
  }

  private async teardown(): Promise<void> {
    this.commandChar = null;
    const connection = this.connection;
    this.connection = null;
    if (connection) {
      try {
        await connection.disconnect();
      } catch {
        // Already gone — that's fine.
      }
    }
  }

  private setState(next: TransportState): void {
    if (this.stateValue !== next) {
      this.stateValue = next;
      this.emit('state', next);
    }
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/transport.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add src/bedjet/transport.ts tests/fakeBle.ts tests/transport.test.ts
git commit -m "feat: BLE transport with reconnect state machine and backoff"
```

---

### Task 6: Transport — write path with retry, and status-silence watchdog

**Files:**
- Modify: `src/bedjet/transport.ts` (add `write`)
- Test: `tests/transport.test.ts` (append)

**Interfaces:**
- Consumes: Task 5 transport internals
- Produces:
  - `BedJetTransport.write(data: Buffer, coalesceKey?: string): Promise<void>` — queued and coalesced; if not READY, rejects with `Error('BedJet is not connected')`; on write failure, forces one reconnect + retry, then rejects.

- [ ] **Step 1: Append failing tests to tests/transport.test.ts**

```ts
describe('BedJetTransport write path', () => {
  it('writes to the command characteristic when READY', async () => {
    const ble = new FakeBleProvider();
    const t = makeTransport(ble);
    t.start();
    await flush();
    await t.write(Buffer.from([0x01, 0x03]));
    expect([...ble.current.commandChar.writes[0]]).toEqual([0x01, 0x03]);
    await t.stop();
  });

  it('rejects fast when disconnected', async () => {
    const ble = new FakeBleProvider();
    ble.failNextConnects = 99;
    const t = makeTransport(ble);
    t.start();
    await flush();
    await expect(t.write(Buffer.from([0x01, 0x01]))).rejects.toThrow('not connected');
    await t.stop();
  });

  it('recovers from a write failure by reconnecting and retrying once', async () => {
    const ble = new FakeBleProvider();
    const t = makeTransport(ble);
    t.start();
    await flush();
    ble.current.commandChar.failNextWrites = 1; // simulates ATT error 0x0e
    await t.write(Buffer.from([0x03, 66]));
    expect(ble.connections).toHaveLength(2); // recycled
    expect([...ble.connections[1].commandChar.writes[0]]).toEqual([0x03, 66]);
    await t.stop();
  });

  it('rejects when the retry also cannot go through', async () => {
    const ble = new FakeBleProvider();
    const t = makeTransport(ble);
    t.start();
    await flush();
    ble.current.commandChar.failNextWrites = 1;
    ble.failNextConnects = 99; // reconnect will fail too
    await expect(t.write(Buffer.from([0x03, 66]))).rejects.toThrow('not connected');
    await t.stop();
  });

  it('coalesces queued writes with the same key', async () => {
    const ble = new FakeBleProvider();
    const t = makeTransport(ble);
    t.start();
    await flush();
    // Three temp writes fired in the same tick (slider drag): the first
    // enters the queue slot; the next two coalesce down to the last one.
    const writes = Promise.all([
      t.write(Buffer.from([0x03, 60]), 'temp'),
      t.write(Buffer.from([0x03, 62]), 'temp'),
      t.write(Buffer.from([0x03, 66]), 'temp'),
    ]);
    await flush();
    await writes;
    const sent = ble.current.commandChar.writes.map((w) => [...w]);
    expect(sent).toEqual([[0x03, 60], [0x03, 66]]); // middle write never sent
    await t.stop();
  });
});

describe('BedJetTransport status watchdog', () => {
  it('recycles the connection after status silence', async () => {
    const ble = new FakeBleProvider();
    const t = makeTransport(ble);
    t.start();
    await flush();
    expect(ble.connections).toHaveLength(1);
    // Watchdog ticks every 15s; first check past the 300s threshold is at 315s.
    await vi.advanceTimersByTimeAsync(320_000);
    await flush();
    expect(ble.connections).toHaveLength(2);
    expect(t.state).toBe('READY');
    await t.stop();
  });

  it('does not recycle while notifications keep arriving', async () => {
    const ble = new FakeBleProvider();
    const t = makeTransport(ble);
    t.start();
    await flush();
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(150_000);
      await flush();
      ble.connections[0].statusChar.notify(makeStatusPacket());
    }
    expect(ble.connections).toHaveLength(1); // 600s elapsed, never silent >300s
    await t.stop();
  });
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx vitest run tests/transport.test.ts`
Expected: FAIL — `t.write` is not a function.

- [ ] **Step 3: Add write() to BedJetTransport (after `stop()`)**

```ts
  /**
   * Sends a command packet. Queued behind any in-flight operation and
   * coalesced by key. On write failure: one forced reconnect + retry,
   * then an honest rejection for HomeKit to surface.
   */
  write(data: Buffer, coalesceKey?: string): Promise<void> {
    return this.queue.enqueue(async () => {
      if (this.stateValue !== 'READY' || !this.commandChar) {
        throw new Error('BedJet is not connected');
      }
      try {
        await this.commandChar.write(data);
      } catch (err) {
        this.log(`write failed (${(err as Error).message}); reconnecting to retry`);
        // Already inside the queue slot, so call recycleNow directly —
        // enqueueing here would deadlock behind ourselves.
        await this.recycleNow();
        if (this.stateValue !== 'READY' || !this.commandChar) {
          throw new Error('BedJet is not connected');
        }
        await this.commandChar.write(data);
      }
    }, coalesceKey);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/transport.test.ts`
Expected: PASS (all, including Task 5's).

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/bedjet/transport.ts tests/transport.test.ts
git commit -m "feat: transport write path with reconnect-retry and silence watchdog"
```

---

### Task 7: BedJet client (state model + typed commands)

**Files:**
- Create: `src/bedjet/client.ts`
- Test: `tests/client.test.ts`

**Interfaces:**
- Consumes: `parseStatus`, `BedJetStatus`, `Button`, packet builders, `percentToFanStep` (Tasks 2–3); `TransportState` (Task 5)
- Produces (consumed by accessory in Task 8):
  - `type SimpleMode = 'off' | 'heat' | 'cool'`
  - `interface BedJetSnapshot extends BedJetStatus { reachable: boolean }`
  - `interface TransportLike { readonly state: TransportState; write(data: Buffer, coalesceKey?: string): Promise<void>; on(event: string, cb: (arg: never) => void): unknown; }` — structurally satisfied by `BedJetTransport`
  - `class BedJetClient extends EventEmitter`: `constructor(transport: TransportLike)`, `get snapshot(): BedJetSnapshot | null`, `setMode(mode: SimpleMode): Promise<void>`, `setTargetTemp(celsius: number): Promise<void>`, `setFanPercent(percent: number): Promise<void>`. Event: `'state'` (BedJetSnapshot).
  - Coalesce keys: `'mode'`, `'temp'`, `'fan'`.
  - `setTargetTemp` clamps to the device-reported `[minTempC, maxTempC]`, defaulting to `[19, 43]` before first status.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/client.test.ts
import { EventEmitter } from 'events';
import { describe, expect, it } from 'vitest';
import { BedJetClient, BedJetSnapshot } from '../src/bedjet/client';
import { TransportState } from '../src/bedjet/transport';
import { BedJetMode } from '../src/bedjet/protocol';
import { makeStatusPacket } from './fixtures';

class FakeTransport extends EventEmitter {
  state: TransportState = 'READY';
  writes: Array<{ data: number[]; key?: string }> = [];
  async write(data: Buffer, coalesceKey?: string): Promise<void> {
    this.writes.push({ data: [...data], key: coalesceKey });
  }
}

function setup() {
  const transport = new FakeTransport();
  const client = new BedJetClient(transport);
  return { transport, client };
}

describe('BedJetClient commands', () => {
  it('sends mode buttons with the mode coalesce key', async () => {
    const { transport, client } = setup();
    await client.setMode('heat');
    await client.setMode('cool');
    await client.setMode('off');
    expect(transport.writes).toEqual([
      { data: [0x01, 0x03], key: 'mode' },
      { data: [0x01, 0x02], key: 'mode' },
      { data: [0x01, 0x01], key: 'mode' },
    ]);
  });

  it('sends target temp, clamped to device limits', async () => {
    const { transport, client } = setup();
    await client.setTargetTemp(33);
    await client.setTargetTemp(50); // above default max 43
    await client.setTargetTemp(10); // below default min 19
    expect(transport.writes.map((w) => w.data)).toEqual([
      [0x03, 66],
      [0x03, 86],
      [0x03, 38],
    ]);
    expect(transport.writes[0].key).toBe('temp');
  });

  it('uses device-reported temp limits once a status arrives', async () => {
    const { transport, client } = setup();
    transport.emit('status', makeStatusPacket({ minStep: 40, maxStep: 80 })); // 20..40°C
    await client.setTargetTemp(50);
    expect(transport.writes[0].data).toEqual([0x03, 80]);
  });

  it('sends fan percent as a fan step', async () => {
    const { transport, client } = setup();
    await client.setFanPercent(40);
    expect(transport.writes).toEqual([{ data: [0x07, 7], key: 'fan' }]);
  });
});

describe('BedJetClient state', () => {
  it('parses status notifications into snapshots and emits them', () => {
    const { transport, client } = setup();
    const seen: BedJetSnapshot[] = [];
    client.on('state', (s: BedJetSnapshot) => seen.push(s));
    transport.emit('status', makeStatusPacket());
    expect(seen).toHaveLength(1);
    expect(seen[0].mode).toBe(BedJetMode.Heat);
    expect(seen[0].currentTempC).toBe(29);
    expect(seen[0].reachable).toBe(true);
    expect(client.snapshot?.targetTempC).toBe(33);
  });

  it('ignores unparseable notifications', () => {
    const { transport, client } = setup();
    transport.emit('status', Buffer.from([0, 5, 0, 2])); // debug packet
    expect(client.snapshot).toBeNull();
  });

  it('marks the snapshot unreachable when the transport drops', () => {
    const { transport, client } = setup();
    transport.emit('status', makeStatusPacket());
    transport.state = 'DISCONNECTED';
    transport.emit('state', 'DISCONNECTED');
    expect(client.snapshot?.reachable).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/client.test.ts`
Expected: FAIL — cannot resolve `../src/bedjet/client`.

- [ ] **Step 3: Implement src/bedjet/client.ts**

```ts
import { EventEmitter } from 'events';
import {
  BedJetStatus, Button, buildButtonPacket, buildSetFanPacket, buildSetTempPacket,
  parseStatus, percentToFanStep,
} from './protocol';
import { TransportState } from './transport';

export type SimpleMode = 'off' | 'heat' | 'cool';

export interface BedJetSnapshot extends BedJetStatus {
  reachable: boolean;
}

/** The slice of BedJetTransport the client needs (kept small for tests). */
export interface TransportLike {
  readonly state: TransportState;
  write(data: Buffer, coalesceKey?: string): Promise<void>;
  on(event: string, cb: (arg: never) => void): unknown;
}

const DEFAULT_MIN_TEMP_C = 19;
const DEFAULT_MAX_TEMP_C = 43;

const BUTTON_FOR_MODE: Record<SimpleMode, Button> = {
  off: Button.Off,
  heat: Button.Heat,
  cool: Button.Cool,
};

/** Typed BedJet commands + last-known state. Emits 'state' (BedJetSnapshot). */
export class BedJetClient extends EventEmitter {
  private lastStatus: BedJetStatus | null = null;

  constructor(private readonly transport: TransportLike) {
    super();
    transport.on('status', (data: Buffer) => this.onStatus(data));
    transport.on('state', () => this.emitSnapshot());
  }

  get snapshot(): BedJetSnapshot | null {
    if (!this.lastStatus) {
      return null;
    }
    return { ...this.lastStatus, reachable: this.transport.state === 'READY' };
  }

  async setMode(mode: SimpleMode): Promise<void> {
    await this.transport.write(buildButtonPacket(BUTTON_FOR_MODE[mode]), 'mode');
  }

  async setTargetTemp(celsius: number): Promise<void> {
    const min = this.lastStatus?.minTempC ?? DEFAULT_MIN_TEMP_C;
    const max = this.lastStatus?.maxTempC ?? DEFAULT_MAX_TEMP_C;
    const clamped = Math.min(max, Math.max(min, celsius));
    await this.transport.write(buildSetTempPacket(clamped), 'temp');
  }

  async setFanPercent(percent: number): Promise<void> {
    await this.transport.write(buildSetFanPacket(percentToFanStep(percent)), 'fan');
  }

  private onStatus(data: Buffer): void {
    const parsed = parseStatus(data);
    if (!parsed) {
      return;
    }
    this.lastStatus = parsed;
    this.emitSnapshot();
  }

  private emitSnapshot(): void {
    const snap = this.snapshot;
    if (snap) {
      this.emit('state', snap);
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/client.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/bedjet/client.ts tests/client.test.ts
git commit -m "feat: BedJet client with typed commands and state snapshots"
```

---

### Task 8: Accessory — HomeKit mapping helpers + services

**Files:**
- Create: `src/accessory.ts`
- Test: `tests/accessory.test.ts` (pure helpers only; the HAP wiring is exercised in on-Pi verification, Task 11)

**Interfaces:**
- Consumes: `BedJetClient`, `BedJetSnapshot`, `SimpleMode` (Task 7); `BedJetMode`, `fanStepToPercent` (Tasks 2–3); `BedJetPlatform` (Task 9 — see note below)
- Produces:
  - `modeToHCState(mode: BedJetMode): 0 | 1 | 2` — HomeKit Off=0/Heat=1/Cool=2 (used for both Current and Target heating-cooling state)
  - `hcStateToSimpleMode(state: number): SimpleMode`
  - `isRunning(mode: BedJetMode): boolean`
  - `clampDisplayTemp(celsius: number): number` — clamps to HomeKit's advertised 19..43 range
  - `class BedJetAccessory` with `constructor(platform: BedJetPlatform, accessory: PlatformAccessory, client: BedJetClient)`
- Note: `src/accessory.ts` imports the `BedJetPlatform` **type** from `./platform` (Task 9). To keep this task compiling on its own, Step 5 creates `src/platform.ts` as a stub that Task 9 replaces. The helper tests import only pure functions, so they don't touch HAP.

- [ ] **Step 1: Write the failing helper tests**

```ts
// tests/accessory.test.ts
import { describe, expect, it } from 'vitest';
import { clampDisplayTemp, hcStateToSimpleMode, isRunning, modeToHCState } from '../src/accessory';
import { BedJetMode } from '../src/bedjet/protocol';

describe('mode mapping', () => {
  it('buckets BedJet modes into HomeKit Off/Heat/Cool', () => {
    expect(modeToHCState(BedJetMode.Standby)).toBe(0);
    expect(modeToHCState(BedJetMode.Wait)).toBe(0);
    expect(modeToHCState(BedJetMode.Heat)).toBe(1);
    expect(modeToHCState(BedJetMode.Turbo)).toBe(1);
    expect(modeToHCState(BedJetMode.ExtendedHeat)).toBe(1);
    expect(modeToHCState(BedJetMode.Cool)).toBe(2);
    expect(modeToHCState(BedJetMode.Dry)).toBe(2);
  });

  it('maps HomeKit target states to simple modes', () => {
    expect(hcStateToSimpleMode(0)).toBe('off');
    expect(hcStateToSimpleMode(1)).toBe('heat');
    expect(hcStateToSimpleMode(2)).toBe('cool');
  });

  it('knows which modes count as running (for the Fan tile)', () => {
    expect(isRunning(BedJetMode.Standby)).toBe(false);
    expect(isRunning(BedJetMode.Wait)).toBe(false);
    expect(isRunning(BedJetMode.Heat)).toBe(true);
    expect(isRunning(BedJetMode.Cool)).toBe(true);
  });

  it('clamps display temps into the advertised HomeKit range', () => {
    expect(clampDisplayTemp(33)).toBe(33);
    expect(clampDisplayTemp(10)).toBe(19); // BedJet cool target can sit below HomeKit min
    expect(clampDisplayTemp(50)).toBe(43);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/accessory.test.ts`
Expected: FAIL — cannot resolve `../src/accessory`.

- [ ] **Step 3: Implement src/accessory.ts**

```ts
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
```

- [ ] **Step 4: Run helper tests to verify they pass**

Run: `npx vitest run tests/accessory.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Create the platform stub so the project compiles**

```ts
// src/platform.ts — stub; replaced with the real platform in the next task.
import type { API, Characteristic, Logger, Service } from 'homebridge';

export interface BedJetPlatform {
  readonly Service: typeof Service;
  readonly Characteristic: typeof Characteristic;
  readonly log: Logger;
  readonly api: API;
}
```

- [ ] **Step 6: Verify the whole project compiles and tests pass**

Run: `npm run build && npm test`
Expected: both exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/accessory.ts src/platform.ts tests/accessory.test.ts
git commit -m "feat: HomeKit accessory with Thermostat + Fanv2 mapping"
```

---

### Task 9: Platform, entry point, node-ble provider, config schema

**Files:**
- Modify: `src/platform.ts` (replace stub with real class; keep the same `Service`/`Characteristic`/`log`/`api` members so `accessory.ts` is untouched)
- Create: `src/index.ts`, `src/bedjet/nodeBleProvider.ts`, `config.schema.json`

**Interfaces:**
- Consumes: everything above
- Produces:
  - `class BedJetPlatform implements DynamicPlatformPlugin` (replaces the Task 8 interface stub — same member names, so no changes in `accessory.ts`)
  - `createNodeBleProvider(): BleProvider & { destroy(): void }`
  - Homebridge entry point registering `PLATFORM_NAME`
- Config contract (matches spec):
  `{ "platform": "BedJetV3", "devices": [{ "name": "BedJet", "mac": "AA:BB:CC:DD:EE:FF" }], "statusTimeoutSeconds": 300, "maxReconnectBackoffSeconds": 60 }`

- [ ] **Step 1: Implement src/bedjet/nodeBleProvider.ts**

```ts
import { createBluetooth } from 'node-ble';
import { BleConnection, BleProvider } from './transport';

const WAIT_DEVICE_TIMEOUT_MS = 30_000;

/**
 * Real BleProvider backed by node-ble (BlueZ over D-Bus). Not unit tested —
 * exercised by the on-Pi verification checklist.
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
```

- [ ] **Step 2: Replace src/platform.ts with the real platform**

```ts
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
    const devices = (this.config.devices ?? []) as BedJetDeviceConfig[];
    const valid: BedJetDeviceConfig[] = [];
    for (const device of devices) {
      if (typeof device.mac === 'string' && MAC_RE.test(device.mac)) {
        valid.push({ name: device.name || 'BedJet', mac: device.mac.toUpperCase() });
      } else {
        this.log.error(
          `Ignoring device "${device.name}": "${device.mac}" is not a MAC address. ` +
          'Find yours with: npx homebridge-bedjet-v3 scan',
        );
      }
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
```

- [ ] **Step 3: Create src/index.ts**

```ts
import type { API } from 'homebridge';
import { BedJetPlatform } from './platform';
import { PLATFORM_NAME } from './settings';

export default (api: API): void => {
  api.registerPlatform(PLATFORM_NAME, BedJetPlatform);
};
```

- [ ] **Step 4: Create config.schema.json**

```json
{
  "pluginAlias": "BedJetV3",
  "pluginType": "platform",
  "singular": true,
  "schema": {
    "type": "object",
    "properties": {
      "name": { "type": "string", "default": "BedJetV3" },
      "devices": {
        "title": "BedJets",
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "name": {
              "title": "Name",
              "type": "string",
              "default": "BedJet",
              "required": true
            },
            "mac": {
              "title": "Bluetooth MAC address",
              "type": "string",
              "required": true,
              "pattern": "^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$",
              "description": "Find it by running: npx homebridge-bedjet-v3 scan"
            }
          }
        }
      },
      "statusTimeoutSeconds": {
        "title": "Status silence timeout (seconds)",
        "type": "integer",
        "default": 300,
        "minimum": 60,
        "description": "Recycle the BLE connection if no status arrives for this long."
      },
      "maxReconnectBackoffSeconds": {
        "title": "Max reconnect backoff (seconds)",
        "type": "integer",
        "default": 60,
        "minimum": 5
      }
    }
  }
}
```

- [ ] **Step 5: Verify build and full test suite**

Run: `npm run build && npm test`
Expected: both exit 0; `dist/index.js`, `dist/platform.js`, `dist/bedjet/nodeBleProvider.js` exist.

- [ ] **Step 6: Commit**

```bash
git add src/platform.ts src/index.ts src/bedjet/nodeBleProvider.ts config.schema.json
git commit -m "feat: Homebridge platform, node-ble provider, config schema"
```

---

### Task 10: Scan CLI

**Files:**
- Create: `src/cli.ts`

**Interfaces:**
- Consumes: `node-ble` directly (deliberately independent of the plugin runtime)
- Produces: `npx homebridge-bedjet-v3 scan` — 30-second BLE scan printing `MAC  name` for devices whose name contains "BEDJET". (Already wired via the `bin` field from Task 1.)

- [ ] **Step 1: Implement src/cli.ts**

```ts
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
```

- [ ] **Step 2: Verify build**

Run: `npm run build && node dist/cli.js`
Expected: build exits 0; running with no args prints `Usage: homebridge-bedjet-v3 scan` and exits 0. (The scan itself needs BlueZ — verified on the Pi in Task 11.)

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/cli.ts
git commit -m "feat: scan CLI to find BedJet MAC addresses"
```

---

### Task 11: README, packaging, and on-Pi verification checklist

**Files:**
- Create: `README.md`

**Interfaces:**
- Consumes: everything
- Produces: install/setup docs and the manual verification checklist from the spec; a `.tgz` the user can install on the Pi.

- [ ] **Step 1: Write README.md**

````markdown
# homebridge-bedjet-v3

Control a BedJet V3 from Apple HomeKit — direct Bluetooth LE, no cloud.

Exposes a **Thermostat** (off / heat / cool + target temperature) and a
**Fan** (speed in 5% steps). Built around a BLE command queue and an
auto-reconnecting state machine, so it recovers from the stale-connection
failures (`DBusError: In Progress`, `ATT error: 0x0e`) that plagued older
BedJet plugins.

## Requirements

- Raspberry Pi (or any Linux host) running Homebridge with BlueZ 5.50+
- Node.js >= 18.15, Homebridge >= 1.8
- BedJet V3 within Bluetooth range. The BedJet allows **one** BLE client:
  close the BedJet phone app, or the plugin cannot connect.

## Install

```bash
# from a release tarball
sudo npm install -g ./homebridge-bedjet-v3-0.1.0.tgz
```

### D-Bus permission (one-time)

node-ble talks to BlueZ over D-Bus. Allow the user that runs Homebridge
(usually `homebridge`) by creating `/etc/dbus-1/system.d/homebridge-bedjet.conf`:

```xml
<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-BUS Bus Configuration 1.0//EN"
  "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <policy user="homebridge">
    <allow own="org.bluez"/>
    <allow send_destination="org.bluez"/>
    <allow send_interface="org.bluez.GattCharacteristic1"/>
    <allow send_interface="org.bluez.GattDescriptor1"/>
    <allow send_interface="org.freedesktop.DBus.ObjectManager"/>
    <allow send_interface="org.freedesktop.DBus.Properties"/>
  </policy>
</busconfig>
```

Then `sudo systemctl restart dbus homebridge`.

## Find your BedJet's MAC address

```bash
npx homebridge-bedjet-v3 scan
```

## Configure

Via the Homebridge UI (recommended), or in `config.json`:

```json
{
  "platforms": [
    {
      "platform": "BedJetV3",
      "devices": [{ "name": "BedJet", "mac": "AA:BB:CC:DD:EE:FF" }]
    }
  ]
}
```

Advanced (defaults shown): `"statusTimeoutSeconds": 300` — recycle the BLE
connection after this much status silence; `"maxReconnectBackoffSeconds": 60`.

## Verification checklist (after install)

- [ ] BedJet appears in the Home app as Thermostat + Fan
- [ ] Set Heat + a target temperature → BedJet starts heating
- [ ] Change fan speed from the Fan tile → BedJet fan changes
- [ ] Turn off from Home app → BedJet stops
- [ ] Change mode on the BedJet remote → Home app reflects it within seconds
- [ ] Unplug the BedJet for a minute, plug back in → plugin reconnects by itself
- [ ] Open the BedJet phone app → Homebridge log says the app may be holding the connection
- [ ] Homebridge restart → accessory restored, still controllable

## Troubleshooting

- **"connect failed ... is the BedJet app open on your phone?"** — the BedJet
  accepts one BLE connection; force-close the phone app.
- **No devices found by scan** — check `bluetoothctl show` says `Powered: yes`,
  and that your user is in the `bluetooth` group.
````

- [ ] **Step 2: Build and pack**

Run: `npm run build && npm pack`
Expected: creates `homebridge-bedjet-v3-0.1.0.tgz` with `dist/`, `config.schema.json`, `README.md` inside (verify with `tar -tzf homebridge-bedjet-v3-0.1.0.tgz`).

- [ ] **Step 3: Full suite one last time**

Run: `npm test`
Expected: PASS (all tests, all files).

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: install guide, D-Bus setup, on-Pi verification checklist"
```

- [ ] **Step 5: On-Pi verification (with the user)**

Install the `.tgz` on the user's Raspberry Pi and walk the README checklist
together. This is the acceptance test for the whole project — the plugin is
not "done" until the checklist passes on real hardware.

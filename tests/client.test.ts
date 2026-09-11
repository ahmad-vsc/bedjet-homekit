import { EventEmitter } from 'events';
import { describe, expect, it } from 'vitest';
import { BedJetClient, BedJetSnapshot } from '../src/bedjet/client';
import { TransportState } from '../src/bedjet/transport';
import { BedJetMode } from '../src/bedjet/protocol';
import { makeStatusPacket } from './fixtures';

class FakeTransport extends EventEmitter {
  state: TransportState = 'READY';
  writes: Array<{ data: number[]; key?: string }> = [];
  failNextWrite = false;
  async write(data: Buffer, coalesceKey?: string): Promise<void> {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error('BedJet is not connected');
    }
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

  it('propagates a transport write rejection as an honest error', async () => {
    const { transport, client } = setup();
    transport.failNextWrite = true;
    // The accessory layer converts this to a HapStatusError (5 lines,
    // verified on-Pi); here we prove the rejection isn't swallowed en route.
    await expect(client.setMode('heat')).rejects.toThrow();
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

import {
  ByteWriter,
  CoreKind,
  encodeSnapshot,
  encodeSnapshotPart,
  REGION_IDX_NONE,
  SNAPSHOT_FLAG_FULL,
  SNAPSHOT_FLAG_STATE_TICKS,
  type SnapshotData,
} from '@conduit/protocol';
import { describe, expect, it, vi } from 'vitest';
import { MemoryTransport, NetClient } from '../src/index.ts';
import { ManualTimers, ScriptedServer, Tag, testGame, testRegistry } from './helpers.ts';

async function setup() {
  const timers = new ManualTimers();
  const registry = testRegistry();
  let server!: ScriptedServer;
  const client = new NetClient({
    url: 'memory://test',
    game: testGame(registry),
    token: 'dev',
    displayName: 'a',
    autoReconnect: false,
    timers,
    now: timers.nowFn,
    log: () => {},
    transport: () => {
      const transport = new MemoryTransport({ timers });
      server = new ScriptedServer(transport.link, registry);
      return transport;
    },
  });
  const connecting = client.connect();
  timers.flush();
  server.welcome({ serverTick: 0, serverTimeMs: 0 });
  timers.flush();
  await connecting;
  const snapshot = (
    tick: number,
    baseline: number,
    full = false,
    stateTick = tick,
  ): SnapshotData => ({
    header: {
      serverTick: tick,
      baselineTick: baseline,
      serverTimeMs: tick * 16,
      lastInputSeq: 0,
      lastInputTick: 0,
      flags: SNAPSHOT_FLAG_STATE_TICKS | (full ? SNAPSHOT_FLAG_FULL : 0),
    },
    regions: [],
    creates: full
      ? [
          {
            entity: 1,
            regionIdx: REGION_IDX_NONE,
            stateTick,
            components: [{ id: registry.componentId(Tag), value: { label: 'a', n: tick } }],
          },
        ]
      : [],
    updates: full
      ? []
      : [
          {
            entity: 1,
            stateTick,
            components: [{ id: registry.componentId(Tag), value: { label: 'a', n: tick } }],
            removed: [],
          },
        ],
    destroys: [],
  });
  const send = (data: SnapshotData) => {
    server.snapshot(data);
    timers.flush();
  };
  send(snapshot(3, 0, true));
  expect(client.mirror.latestTick).toBe(3);
  const part = (data: SnapshotData, index = 0, reset = false) => {
    const writer = new ByteWriter();
    encodeSnapshot(writer, registry, data);
    const bytes = writer.view();
    const split = Math.ceil(bytes.length / 2);
    server.frame([
      {
        kind: CoreKind.SnapshotPart,
        encode: (w) =>
          encodeSnapshotPart(w, {
            id: 7,
            tick: data.header.serverTick,
            baselineTick: data.header.baselineTick,
            index,
            count: 2,
            totalBytes: bytes.length,
            reset,
            data: bytes.slice(index === 0 ? 0 : split, index === 0 ? split : undefined),
          }),
      },
    ]);
    timers.flush();
  };
  return { client, server, timers, snapshot, send, part };
}

describe('NetClient snapshot transaction admission', () => {
  it('rejects a direct delta replacing an incomplete transaction before apply or Ack', async () => {
    const h = await setup();
    const acks = h.server.all('Ack').length;
    h.part(h.snapshot(6, 3));
    h.send(h.snapshot(9, 6));
    expect(h.client.state).toBe('Disconnected');
    expect(h.client.mirror.latestTick).toBe(3);
    expect(h.server.all('Ack')).toHaveLength(acks);
  });
  it('rejects baseline gaps and backwards entity stamps before replica mutation', async () => {
    for (const data of ['gap', 'stamp'] as const) {
      const h = await setup();
      const acks = h.server.all('Ack').length;
      h.send(h.snapshot(6, data === 'gap' ? 4 : 3, false, data === 'stamp' ? 2 : 6));
      expect(h.client.state).toBe('Disconnected');
      expect(h.client.mirror.latestTick).toBe(data === 'stamp' ? 0 : 3);
      expect(h.client.mirror.read(1, Tag)?.n).toBe(data === 'stamp' ? undefined : 3);
      expect(h.server.all('Ack')).toHaveLength(acks);
    }
  });
  it('invalidates a partially applied mirror before publishing the failure', async () => {
    const h = await setup();
    const original = h.client.mirror.applySnapshot.bind(h.client.mirror);
    vi.spyOn(h.client.mirror, 'applySnapshot').mockImplementation((data) => {
      original(data);
      throw Error('injected field copy failure');
    });
    let visible = -1;
    h.client.on('error', () => {
      visible = h.client.mirror.size;
    });
    h.send(h.snapshot(6, 3));
    expect(visible).toBe(0);
    expect(h.client.mirror.size).toBe(0);
    expect(h.client.state).toBe('Disconnected');
  });
  it('allows an explicit complete FULL reset to replace pending data', async () => {
    const h = await setup();
    h.part(h.snapshot(6, 3));
    h.send(h.snapshot(9, 0, true));
    expect(h.client.state).not.toBe('Disconnected');
    expect(h.client.mirror.latestTick).toBe(9);
    expect(h.client.mirror.read(1, Tag)?.n).toBe(9);
    h.client.disconnect();
  });
});

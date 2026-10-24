import { defineMessage, f, SNAPSHOT_FLAG_FULL } from '@conduit/protocol';
import { Transform } from '@conduit/sim';
import { describe, expect, it, vi } from 'vitest';
import {
  Crate,
  createHarness,
  eventsOf,
  Horn,
  joinAndSpawn,
  Notice,
  payloadOf,
  scriptedEvents,
  snapshotsOf,
  SPAWN_REGION,
} from './harness.ts';

describe('Session bounded replication delivery', () => {
  it('delivers oversized full populations and updates as complete transactions', async () => {
    const h = await createHarness({ snapshotEvery: 1, cratesPerRegion: 450 });
    const client = h.client();
    const joined = await joinAndSpawn(h, client);
    const snapshots = snapshotsOf(joined);
    for (let i = 0; i < 12 && !snapshots.some((s) => s.creates.length > 1000); i++) {
      await h.step();
      snapshots.push(...snapshotsOf(client.take()));
    }
    const full = snapshots.find((s) => s.creates.length > 1000)!;
    expect(full).toBeDefined();
    expect(full.header.flags & SNAPSHOT_FLAG_FULL).not.toBe(0);
    client.ack(full.header.serverTick);
    client.take();
    const entities = full.creates
      .map((c) => c.entity)
      .filter((entity) => h.session.world.has(entity, Transform));
    for (const entity of entities)
      h.session.world.mutate(entity, Transform, (value) => {
        value.pos.x += 1;
      });
    let update;
    for (let i = 0; i < 12 && !update; i++) {
      await h.step();
      for (const frame of client.link.sent) expect(frame.byteLength).toBeLessThanOrEqual(65546);
      update = snapshotsOf(client.take()).find((s) => s.updates.length === entities.length);
    }
    expect(update?.updates).toHaveLength(entities.length);
    expect(h.session.stats.tickErrors).toBe(0);
    await h.session.stop();
  });
  it('abandons an incomplete stream on reconnect and repopulates from a new full transaction', async () => {
    const h = await createHarness({
      snapshotEvery: 1,
      cratesPerRegion: 300,
      session: { replication: { maxFrameBytes: 2048 } },
    });
    const first = h.client();
    const joined = await joinAndSpawn(h, first);
    expect(snapshotsOf(joined)).toEqual([]);
    first.link.remoteClose(1006);
    await h.step();
    const next = h.client();
    next.hello({
      reconnectToken: payloadOf<{ reconnectToken: string }>(joined, 'Welcome').reconnectToken,
    });
    await h.step();
    const welcome = next.take();
    next.regionLoadState(payloadOf<{ active: string[] }>(welcome, 'RegionSet').active);
    let full;
    for (let i = 0; i < 100 && !full; i++) {
      await h.step();
      for (const frame of next.link.sent) expect(frame.length).toBeLessThanOrEqual(2048);
      full = snapshotsOf(next.take()).find((s) => (s.header.flags & SNAPSHOT_FLAG_FULL) !== 0);
    }
    expect(full?.creates.length).toBeGreaterThan(1000);
    expect(full?.header.baselineTick).toBe(0);
    await h.session.stop();
  });
  it('makes fragment progress at the minimum supported rate without inactivity expiry', async () => {
    const h = await createHarness({
      snapshotEvery: 1,
      cratesPerRegion: 0,
      session: { replication: { bytesPerSecond: 32, burstBytes: 64, maxFrameBytes: 512 } },
    });
    const client = h.client();
    await joinAndSpawn(h, client);
    let full = false;
    let completed = 0;
    for (let i = 0; i < 900; i++) {
      await h.step();
      for (const snapshot of snapshotsOf(client.take())) {
        if (snapshot.header.flags & SNAPSHOT_FLAG_FULL) full = true;
        client.ack(snapshot.header.serverTick);
        completed++;
      }
    }
    expect(full).toBe(true);
    expect(completed).toBeGreaterThan(1);
    expect(client.link.closedWith).toBeNull();
    await h.session.stop();
  });
  it('does not commit a failed handoff and reconnects with a complete full population', async () => {
    const h = await createHarness({ snapshotEvery: 1 });
    const first = h.client();
    const joined = await joinAndSpawn(h, first);
    await h.step();
    first.take();
    const before = h.session.stats.snapshotsSent;
    vi.spyOn(first.link, 'send').mockImplementation(() => {
      throw Error('injected handoff failure');
    });
    await h.step();
    expect(h.session.stats.snapshotsSent).toBe(before);
    const token = payloadOf<{ reconnectToken: string }>(joined, 'Welcome').reconnectToken;
    const next = h.client();
    next.hello({ reconnectToken: token });
    await h.step();
    const welcomed = next.take();
    const regions = payloadOf<{ active: string[] }>(welcomed, 'RegionSet');
    next.regionLoadState(regions.active);
    const snapshots = snapshotsOf(welcomed);
    for (
      let i = 0;
      i < 12 && !snapshots.some((s) => (s.header.flags & SNAPSHOT_FLAG_FULL) !== 0);
      i++
    ) {
      await h.step();
      snapshots.push(...snapshotsOf(next.take()));
    }
    expect(
      snapshots.some((s) => (s.header.flags & SNAPSHOT_FLAG_FULL) !== 0 && s.creates.length > 0),
    ).toBe(true);
    await h.session.stop();
  });
  it('bounds queued game messages by count and encoded bytes with a per-peer failure', async () => {
    const h = await createHarness();
    const a = h.client();
    const b = h.client();
    await joinAndSpawn(h, a, 'a');
    await joinAndSpawn(h, b, 'b');
    for (let i = 0; i < 1025; i++) h.session.send(0, Notice, { code: i });
    expect(a.link.closedWith?.reason).toContain('queue capacity');
    expect(b.link.closedWith).toBeNull();
    await h.session.stop();
    const Large = defineMessage('Large', 's2c', { text: f.str(65500) });
    const large = await createHarness({ messages: [Large] });
    const peer = large.client();
    await joinAndSpawn(large, peer);
    for (let i = 0; i < 17; i++) large.session.send(0, Large, { text: 'x'.repeat(65500) });
    expect(peer.link.closedWith?.reason).toContain('queue capacity');
    await large.session.stop();
  });
  it('delivers an event dependent on a destroy in the same completed transaction', async () => {
    const script = scriptedEvents();
    let entity = 0;
    const h = await createHarness({
      snapshotEvery: 1,
      systems: [script.system],
      session: { replication: {} },
      hooks: {
        eventDependencies: (_player, event) =>
          (event.payload as { entity?: number }).entity === entity ? [entity] : [],
      },
    });
    const client = h.client();
    await joinAndSpawn(h, client);
    await h.step();
    client.take();
    entity = h.session.regions.entitiesIn(SPAWN_REGION).find((e) => h.session.world.has(e, Crate))!;
    script.at(h.session.tick + 1, Horn, { entity, pitch: 7 }, SPAWN_REGION);
    h.session.world.destroy(entity);
    await h.step();
    const messages = client.take();
    expect(snapshotsOf(messages).some((snapshot) => snapshot.destroys.includes(entity))).toBe(true);
    expect(
      eventsOf(h.game.registry, messages).some(
        (event) => event.name === 'Horn' && (event.payload as { entity: number }).entity === entity,
      ),
    ).toBe(true);
    await h.session.stop();
  });
  it('keeps repeated transactions within finite reserved credits after the initial burst', async () => {
    const h = await createHarness({
      snapshotEvery: 1,
      cratesPerRegion: 0,
      session: { replication: { bytesPerSecond: 512, burstBytes: 512, maxFrameBytes: 512 } },
    });
    const client = h.client();
    await joinAndSpawn(h, client);
    client.take();
    let bytes = 0;
    let completed = 0;
    const started = h.clock.now();
    for (let i = 0; i < 180; i++) {
      const player = h.session.players()[0]!;
      if (player.entity !== undefined && h.session.world.has(player.entity, Transform))
        h.session.world.mutate(player.entity, Transform, (value) => {
          value.pos.x += 0.01;
        });
      await h.step();
      for (const frame of client.link.sent) {
        expect(frame.length).toBeLessThanOrEqual(512);
        bytes += frame.length;
      }
      for (const snapshot of snapshotsOf(client.take())) {
        client.ack(snapshot.header.serverTick);
        completed++;
      }
    }
    expect(completed).toBeGreaterThan(3);
    expect(bytes).toBeLessThanOrEqual(512 + (512 * (h.clock.now() - started)) / 1000);
    expect(h.session.stats.tickErrors).toBe(0);
    await h.session.stop();
  });
});

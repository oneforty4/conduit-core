// @conduit/net-client is isomorphic and its sources name DOM event types; type-checking them
// from this Node package needs the DOM lib.
/// <reference lib="dom" />
import type { DiagnosticRecord } from '@conduit/math';
import { ReplicaWorld } from '@conduit/net-client';
import { f, type SnapshotData } from '@conduit/protocol';
import { defineComponent, type EntityId, Name, Owner, Transform } from '@conduit/sim';
import { describe, expect, it } from 'vitest';
import type { HookContext, PlayerInfo, SessionHooks, SessionOptions } from '../src/session.ts';
import type { FakeLink } from './fake-link.ts';
import {
  createHarness,
  type Harness,
  joinAndSpawn,
  type ReceivedMessage,
  snapshotsOf,
  type TestClient,
} from './harness.ts';

/** Name stands in for state only its owner's prediction reads (docs/net.md A.8.4). */
const OWNER_ONLY = Object.freeze([Name]);

function ownerOnly(player: PlayerInfo, entity: EntityId, ctx: HookContext) {
  if (!ctx.world.has(entity, Owner)) return undefined;
  return ctx.world.get(entity, Owner).player === player.playerId ? undefined : OWNER_ONLY;
}

/** A client of the harness with the replica its snapshots build, and every snapshot it got. */
interface Viewer {
  client: TestClient;
  replica: ReplicaWorld;
  snapshots: SnapshotData[];
  entity: EntityId;
  playerId: number;
}

function feed(viewer: Viewer, messages: ReceivedMessage[] = viewer.client.take()): void {
  for (const snapshot of snapshotsOf(messages)) {
    viewer.replica.applySnapshot(snapshot);
    viewer.snapshots.push(snapshot);
    viewer.client.ack(snapshot.header.serverTick);
  }
}

async function join(h: Harness, name: string, others: Viewer[]): Promise<Viewer> {
  const client = h.client();
  const replica = new ReplicaWorld(h.game.registry, h.game.components, {
    tickRate: 60,
    snapshotEvery: 3,
  });
  const viewer: Viewer = { client, replica, snapshots: [], entity: 0, playerId: -1 };
  const seen = await joinAndSpawn(h, client, name);
  feed(viewer, seen);
  for (const other of others) feed(other);
  const player = h.session.players().find((p) => p.displayName === name)!;
  viewer.entity = player.entity;
  viewer.playerId = player.playerId;
  return viewer;
}

async function steps(h: Harness, n: number, viewers: Viewer[]): Promise<void> {
  for (let i = 0; i < n; i++) {
    await h.step();
    for (const viewer of viewers) feed(viewer);
  }
}

/** Whether `snapshots` ever carried component `id` of `entity`. */
function carried(snapshots: SnapshotData[], entity: EntityId, id: number): boolean {
  return snapshots.some((s) =>
    [...s.creates, ...s.updates].some(
      (record) => record.entity === entity && record.components.some((c) => c.id === id),
    ),
  );
}

const MODES: Record<string, Partial<SessionOptions>> = {
  legacy: {},
  planner: { replication: {} },
};

for (const [mode, session] of Object.entries(MODES))
  describe(`withheldComponents with ${mode} replication (docs/net.md A.8.4)`, () => {
    async function pair(hooks: Partial<SessionHooks>) {
      const h = await createHarness({ cratesPerRegion: 1, hooks, session });
      const ann = await join(h, 'ann', []);
      const bob = await join(h, 'bob', [ann]);
      await steps(h, 6, [ann, bob]);
      return { h, ann, bob, nameId: h.game.registry.componentId(Name) };
    }

    it('sends an owner-only component to its owner alone, and hands it over with the entity', async () => {
      const { h, ann, bob, nameId } = await pair({ withheldComponents: ownerOnly });
      expect(ann.replica.read(ann.entity, Name)).toEqual({ value: 'ann' });
      expect(ann.replica.read(bob.entity, Name)).toBeUndefined();
      expect(ann.replica.read(bob.entity, Transform)).toBeDefined(); // the rest still comes
      expect(bob.replica.read(bob.entity, Name)).toEqual({ value: 'bob' });
      expect(bob.replica.read(ann.entity, Name)).toBeUndefined();
      expect(bob.replica.readAt(ann.entity, Name, h.session.tick)).toBeUndefined();
      expect(carried(ann.snapshots, bob.entity, nameId)).toBe(false);
      expect(carried(bob.snapshots, ann.entity, nameId)).toBe(false);

      // Bob's aircraft passes to Ann: Ann gets its Name whole, Bob has it removed.
      const before = h.session.tick;
      h.session.world.mutate(bob.entity, Owner, (owner) => {
        owner.player = ann.playerId;
      });
      await steps(h, 6, [ann, bob]);
      expect(ann.replica.read(bob.entity, Name)).toEqual({ value: 'bob' });
      expect(bob.replica.read(bob.entity, Name)).toBeUndefined();
      expect(bob.replica.readAt(bob.entity, Name, before)).toEqual({ value: 'bob' });
      expect(bob.replica.read(bob.entity, Transform)).toBeDefined();
      expect(h.session.stats.tickErrors).toBe(0);
      await h.session.stop();
    });

    it("a throwing hook fails only that player's snapshot for the tick", async () => {
      let broken = false;
      const { h, ann, bob } = await pair({
        withheldComponents(player, entity, ctx) {
          if (broken && player.displayName === 'bob') throw new Error('policy bug');
          return ownerOnly(player, entity, ctx);
        },
      });
      const counts = [ann.snapshots.length, bob.snapshots.length];
      broken = true;
      await steps(h, 6, [ann, bob]);
      expect(ann.snapshots.length).toBeGreaterThan(counts[0]!);
      expect(bob.snapshots.length).toBe(counts[1]);
      expect(h.session.stats.tickErrors).toBeGreaterThan(0);
      expect(h.log).toHaveBeenCalledWith(
        'error',
        `snapshot for player ${bob.playerId} failed`,
        expect.objectContaining({ message: 'policy bug' }),
      );
      expect(h.session.fault).toBeNull();
      broken = false;
      await steps(h, 6, [ann, bob]);
      expect(bob.snapshots.length).toBeGreaterThan(counts[1]!);
      await h.session.stop();
    });

    it('a component the registry does not know is an error for that snapshot', async () => {
      const Foreign = Object.freeze([defineComponent('Foreign', { v: f.u8 })]);
      let foreign = false;
      const { h, bob } = await pair({
        withheldComponents: (player, entity, ctx) =>
          foreign && player.displayName === 'bob' ? Foreign : ownerOnly(player, entity, ctx),
      });
      const count = bob.snapshots.length;
      foreign = true;
      await steps(h, 3, [bob]);
      expect(bob.snapshots.length).toBe(count);
      expect(h.log).toHaveBeenCalledWith(
        'error',
        `snapshot for player ${bob.playerId} failed`,
        expect.any(RangeError),
      );
      await h.session.stop();
    });

    it('drops a queued snapshot that would carry a component withheld since it was built', async () => {
      const records: DiagnosticRecord[] = [];
      // While `backUp`, building a snapshot backs the link up, so the snapshot stays queued.
      const held: { link?: FakeLink; backUp: boolean } = { backUp: false };
      const h = await createHarness({
        cratesPerRegion: 0,
        hooks: {
          withheldComponents(player, entity, ctx) {
            if (held.backUp && held.link !== undefined) held.link.buffered = 1 << 20;
            return ownerOnly(player, entity, ctx);
          },
        },
        session: { ...session, diagnostics: { observer: { observe: (r) => records.push(r) } } },
      });
      const ann = await join(h, 'ann', []);
      held.link = ann.client.link;
      await steps(h, 6, [ann]);
      h.session.world.mutate(ann.entity, Name, (name) => {
        name.value = 'secret';
      });
      held.backUp = true;
      for (let i = 0; i < 3 && ann.client.link.buffered === 0; i++) await steps(h, 1, [ann]);
      held.backUp = false;
      expect(ann.client.link.buffered).toBeGreaterThan(0); // built, and queued unsent
      const resets = records.filter((r) => r.name === 'assembly-reset').length;
      // Ann's aircraft passes to another player before the queued snapshot goes.
      h.session.world.mutate(ann.entity, Owner, (owner) => {
        owner.player = 7;
      });
      ann.client.link.buffered = 0;
      await steps(h, 12, [ann]);
      expect(records.filter((r) => r.name === 'assembly-reset').length).toBe(resets + 1);
      const secret = ann.snapshots.some((snapshot) =>
        [...snapshot.creates, ...snapshot.updates].some((record) =>
          record.components.some((c) => (c.value as { value?: string }).value === 'secret'),
        ),
      );
      expect(secret).toBe(false);
      expect(ann.replica.read(ann.entity, Name)).toBeUndefined();
      expect(ann.replica.read(ann.entity, Transform)).toBeDefined();
      await h.session.stop();
    });
  });

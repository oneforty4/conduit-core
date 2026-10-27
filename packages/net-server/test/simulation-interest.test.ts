// @conduit/net-client is isomorphic and its sources name DOM event types; type-checking them
// from this Node package needs the DOM lib.
/// <reference lib="dom" />
import { defineSchema, f, type EntityId, type RegionSetPayload } from '@conduit/protocol';
import { Name, Owner, SimulationFault } from '@conduit/sim';
import { stringCompare, type RegionId } from '@conduit/world';
import { describe, expect, it, vi } from 'vitest';
import { SIMULATION_INTEREST_REGIONS_LIMIT } from '../src/constants.ts';
import { defineExternalCommand, type HookContext, type PlayerInfo } from '../src/session.ts';
import {
  Crate,
  createHarness,
  eventsOf,
  Horn,
  joinAndSpawn,
  payloadOf,
  type ReceivedMessage,
  scriptedEvents,
  Shout,
  snapshotsOf,
  SPAWN_REGION,
} from './harness.ts';

// SessionHooks.simulationInterest and SessionOptions.maxSimulationInterestRegions (docs/net.md
// A.5): regions kept simulated independent of players, never visible to clients because of it.

/** Regions named by the `Name` of every regionless `Crate` ("beacon"), in entity order. */
function beacons(ctx: HookContext): RegionId[] {
  const out: RegionId[] = [];
  for (const e of ctx.world.query(Crate, Name)) out.push(ctx.world.get(e, Name).value);
  return out;
}

function addBeacon(ctx: HookContext, region: string): void {
  const e = ctx.world.create();
  ctx.world.add(e, Crate, {});
  ctx.world.add(e, Name, { value: region });
}

describe('SessionHooks.simulationInterest', () => {
  it('runs once per tick after messages and external commands, right before regions.update, seeing their changes', async () => {
    const order: string[] = [];
    const beacon = defineExternalCommand(
      'beacon',
      defineSchema({ region: f.str(32) }),
      (payload, ctx) => {
        order.push('external');
        addBeacon(ctx, payload.region);
      },
    );
    const simulationInterest = vi.fn((ctx: HookContext) => {
      order.push(`interest stepping=${String(ctx.world.stepping)}`);
      return [...beacons(ctx)].reverse(); // any order: the Session sorts
    });
    const h = await createHarness({
      hooks: {
        onMessage: (_player, _def, payload, ctx) => {
          order.push('onMessage');
          addBeacon(ctx, (payload as { text: string }).text);
        },
        simulationInterest,
      },
      session: { externalCommands: [beacon] },
    });
    const a = h.client();
    await joinAndSpawn(h, a);
    expect(simulationInterest).toHaveBeenCalledTimes(h.session.tick);
    expect(simulationInterest).toHaveBeenCalledWith(h.session.ctx);

    const { regions } = h.session;
    const update = regions.update.bind(regions);
    const updates: (readonly RegionId[] | undefined)[] = [];
    vi.spyOn(regions, 'update').mockImplementation((players, ctx, pending, interest) => {
      order.push('regions.update');
      updates.push(interest);
      update(players, ctx, pending, interest);
    });
    a.sendMessage(Shout, { text: 'cell/3_3' });
    h.session.enqueueExternalCommand('beacon', { region: 'cell/0_3' });
    order.length = 0;
    const calls = simulationInterest.mock.calls.length;
    await h.step();
    expect(order).toEqual(['onMessage', 'external', 'interest stepping=false', 'regions.update']);
    expect(simulationInterest.mock.calls.length - calls).toBe(1);
    expect(updates).toEqual([['cell/0_3', 'cell/3_3']]);
    expect(regions.state('cell/3_3')).toBe('loading');
    expect(regions.state('cell/0_3')).toBe('loading');
    await h.step();
    expect(regions.state('cell/3_3')).toBe('active');
    // Exactly the interest regions: not their neighbourhood beyond the player's.
    expect(regions.state('cell/3_2')).toBe('inactive');
    await h.step(5);
    expect(simulationInterest.mock.calls.length - calls).toBe(7);
    await h.session.stop();
  });

  it('keeps an interest region active with no player connected; dropped, it lingers and is evicted', async () => {
    let interest: RegionId[] = ['cell/6_6'];
    // 10 Hz: LINGER_MS is 100 ticks.
    const h = await createHarness({
      cols: 8,
      rows: 8,
      tickRate: 10,
      hooks: { simulationInterest: () => interest },
    });
    await h.step(2);
    const { regions } = h.session;
    expect(regions.active()).toEqual(['cell/6_6']);
    expect(h.loader.populated).toEqual(['cell/6_6']);
    const crates = [...regions.entitiesIn('cell/6_6')];
    expect(crates).toHaveLength(2);
    expect(h.session.players()).toEqual([]);
    await h.step(250);
    expect(regions.active()).toEqual(['cell/6_6']);
    expect(regions.lingering('cell/6_6')).toBe(false);

    interest = [];
    await h.step();
    expect(regions.lingering('cell/6_6')).toBe(true);
    await h.step(99);
    expect(regions.state('cell/6_6')).toBe('active');
    await h.step();
    expect(regions.active()).toEqual([]);
    await h.step(); // the save completes at this boundary
    expect(regions.state('cell/6_6')).toBe('inactive');
    for (const e of crates) expect(h.session.world.alive(e)).toBe(false);
    expect(h.session.fault).toBeNull();
    await h.session.stop();
  });

  it('deduplicates within the cap, and validates the option', async () => {
    const h = await createHarness({
      hooks: { simulationInterest: () => ['cell/0_1', 'cell/0_0', 'cell/0_1'] },
      session: { maxSimulationInterestRegions: 2 },
    });
    await h.step(2);
    expect(h.session.fault).toBeNull();
    expect(h.session.regions.active()).toEqual(['cell/0_0', 'cell/0_1']);
    await h.session.stop();

    for (const max of [0, SIMULATION_INTEREST_REGIONS_LIMIT]) {
      const ok = await createHarness({
        start: false,
        session: { maxSimulationInterestRegions: max },
      });
      expect(ok.session.running).toBe(false);
    }
    for (const max of [-1, 1.5, Number.NaN, SIMULATION_INTEREST_REGIONS_LIMIT + 1]) {
      await expect(
        createHarness({ start: false, session: { maxSimulationInterestRegions: max } }),
      ).rejects.toThrow(RangeError);
    }
  });

  it.each([
    [
      'an unknown region id',
      () => ['cell/3_3', 'nowhere'],
      RangeError,
      "'nowhere' is not a region",
    ],
    ['a value that is not a region id', () => ['cell/3_3', 7], RangeError, '7 is not a region'],
    [
      'more regions than the cap',
      () => ['cell/3_1', 'cell/3_2', 'cell/3_3'],
      RangeError,
      'more than 2',
    ],
    ['a result that is not an array', () => 'cell/3_3', TypeError, 'must return an array'],
    [
      'a throw',
      () => {
        throw new Error('interest failed');
      },
      Error,
      'interest failed',
    ],
  ])('faults the session for %s, before regions.update', async (_name, hook, type, message) => {
    const report = vi.fn<(fault: SimulationFault) => void>();
    let armed = false;
    const h = await createHarness({
      hooks: {
        simulationInterest: () => (armed ? (hook() as unknown as RegionId[]) : []),
      },
      session: { maxSimulationInterestRegions: 2, onFault: report },
    });
    const a = h.client();
    await joinAndSpawn(h, a);
    a.take();
    const update = vi.spyOn(h.session.regions, 'update');
    armed = true;
    const t = h.session.tick + 1;
    await h.step();
    expect(h.session.fault).toBeInstanceOf(SimulationFault);
    expect(h.session.fault).toMatchObject({ tick: t, system: 'simulationInterest', phase: 'hook' });
    const cause = h.session.fault?.cause as Error;
    expect(cause).toBeInstanceOf(type);
    expect(cause.message).toContain(message);
    expect(update).not.toHaveBeenCalled();
    expect(h.session.regions.state('cell/2_2')).toBe('active'); // the player's neighbourhood only
    expect(h.session.regions.state('cell/3_3')).toBe('inactive');
    expect(report).toHaveBeenCalledTimes(1);
    expect(a.take()).toEqual([]);
    expect(a.link.closedWith).toMatchObject({ code: 4012 });
    expect(h.session.running).toBe(false);
    await h.session.stop();
  });

  it("never reaches a client's RegionSet, snapshots, events or relevance", async () => {
    const FAR = 'cell/6_6'; // beyond the player's wanted set and its prefetch ring
    const scripted = scriptedEvents();
    const relevance = vi.fn((_player: PlayerInfo, _e: EntityId, _ctx: HookContext) => true);
    const h = await createHarness({
      cols: 8,
      rows: 8,
      systems: [scripted.system],
      hooks: { simulationInterest: () => [FAR], relevance },
    });
    const a = h.client();
    const seen: ReceivedMessage[] = await joinAndSpawn(h, a);
    const set = payloadOf<RegionSetPayload>(seen, 'RegionSet');
    const { session } = h;
    expect(set.active).toEqual(
      [...session.interest.wantedForRegion(SPAWN_REGION)].sort(stringCompare),
    );
    expect(set.prefetch).toEqual(
      [...session.interest.prefetchForRegion(SPAWN_REGION)].sort(stringCompare),
    );
    expect([...set.active, ...set.prefetch]).not.toContain(FAR);
    expect(session.regions.state(FAR)).toBe('active');
    const far = [...session.regions.entitiesIn(FAR)];
    expect(far.length).toBeGreaterThan(0);

    // The client even claims FAR is loaded: reported but not wanted, it contributes nothing.
    a.regionLoadState([...set.active, FAR]);
    const player = session.players()[0]?.entity as EntityId;
    expect(session.world.get(player, Owner).player).toBe(0);
    scripted.at(session.tick + 2, Horn, { entity: far[0] as EntityId, pitch: 1 }, FAR);
    scripted.at(session.tick + 2, Horn, { entity: player, pitch: 2 }, SPAWN_REGION);
    relevance.mockClear();
    await h.step(9);
    seen.push(...a.take());

    expect(seen.filter((m) => m.name === 'RegionSet')).toHaveLength(1);
    const sent = snapshotsOf(seen).flatMap((s) => s.creates.map((c) => c.entity));
    expect(sent).toContain(player);
    for (const e of far) expect(sent).not.toContain(e);
    const horns = eventsOf(h.game.registry, seen).filter((ev) => ev.name === 'Horn');
    expect(horns.map((ev) => ev.region)).toEqual([SPAWN_REGION]);
    for (const [, e] of relevance.mock.calls) expect(far).not.toContain(e);
    expect(relevance).toHaveBeenCalled();
    await session.stop();
  });
});

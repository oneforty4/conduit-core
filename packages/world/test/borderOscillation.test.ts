import { Owner, Region, Transform, defineSystem, type EntityId } from '@conduit/sim';
import { describe, expect, it } from 'vitest';
import { GridWorld, toWorld, type RegionId } from '../src/index.ts';
import { Crate, at, defOf, place, rig } from './rig.ts';

// docs/world.md §10 `test/borderOscillation.test.ts`: a player crossing the cell/1_1 | cell/2_1
// border every 30 ticks for 2 minutes at 60 Hz never makes a region save, and crates wandering
// between the 9 regions are never lost, duplicated or double-listed.

const CELL = 64;
const WORLD = 3 * CELL;
const TICKS = 7200;
const CRATES_PER_REGION = 20;
/** The player's speed along x, in m per tick: 7.5 m from the border, so it crosses every 30 ticks. */
const PLAYER_SPEED = 0.5;
/** Crates bounce off this margin inside the world, so none ever reaches its edge. */
const MARGIN = 2;

interface Run {
  hashes: number[];
  playerCrossings: number;
  crateMoves: number;
  failures: string[];
}

async function run(): Promise<Run> {
  const graph = new GridWorld({ cellSize: CELL, cols: 3, rows: 3, worldSeed: 31 });
  // The player turns around every 30 ticks.
  const pace = defineSystem('pace', 'input', (ctx) => {
    for (const e of ctx.world.query(Owner, Transform)) {
      const outward = Math.floor((ctx.tick - 1) / 30) % 2 === 0;
      const t = ctx.world.write(e, Transform);
      t.vel.x = outward ? PLAYER_SPEED : -PLAYER_SPEED;
    }
  });
  // Crates reflect off the world margin (region-local positions, so through the region origin).
  const bounce = defineSystem('bounce', 'preSim', (ctx) => {
    const { world, regions } = ctx;
    for (const e of world.query(Crate, Transform)) {
      const def = regions.def(world.get(e, Region).id);
      if (def === undefined) continue;
      const { pos, vel } = world.get(e, Transform);
      const o = def.bounds.origin;
      const x = o.x + pos.x + vel.x;
      const z = o.z + pos.z + vel.z;
      if (x < MARGIN || x > WORLD - MARGIN) world.write(e, Transform).vel.x = -vel.x;
      if (z < MARGIN || z > WORLD - MARGIN) world.write(e, Transform).vel.z = -vel.z;
    }
  });
  const h = rig({
    graph,
    systems: [pace, bounce],
    content(region, ctx, blob) {
      if (blob !== null) return;
      const rng = ctx.regionRng(region.id);
      for (let n = 0; n < CRATES_PER_REGION; n++) {
        const pos = at(4 + rng.float() * (CELL - 8), 4 + rng.float() * (CELL - 8));
        const vel = at(rng.int(-4, 4) / 16, rng.int(-4, 4) / 16);
        ctx.world.add(place(ctx.world, region.id, pos, vel), Crate, { n });
      }
    },
  });
  const player = place(h.world, 'cell/1_1', at(CELL - 7.5, CELL / 2));
  h.world.add(player, Owner, { player: 0 });
  const all = graph.wanted('cell/1_1');
  const failures: string[] = [];
  const hashes: number[] = [];
  const fail = (msg: string): void => {
    if (failures.length < 20) failures.push(`tick ${h.world.tick}: ${msg}`);
  };

  for (let i = 0; i < TICKS; i++) {
    await h.tick([player]);
    hashes.push(h.world.hash());
    const loaded = h.world.tick >= 2; // wanted at tick 1, active from tick 2
    for (const id of all) {
      const state = h.regions.state(id);
      if (state === 'saving') fail(`${id} is saving`);
      if (loaded && state !== 'active') fail(`${id} is ${state}`);
    }
    if (!loaded) continue;

    const current = h.regions.regionOf(player) as RegionId;
    const wanted = graph.wanted(current).length;
    if (h.regions.active().length !== 9) fail(`${h.regions.active().length} regions active`);
    if (wanted !== (current === 'cell/1_1' ? 9 : 6)) fail(`${current} wants ${wanted} regions`);

    const crates = h.world.queryInto([], Crate).length;
    if (crates !== 9 * CRATES_PER_REGION) fail(`${crates} crates`);
    const listed = new Set<EntityId>();
    let listings = 0;
    for (const id of h.regions.active()) {
      for (const e of h.regions.entitiesIn(id)) {
        listed.add(e);
        listings++;
        if (h.world.get(e, Region).id !== id) fail(`${e} listed in ${id}`);
      }
    }
    if (listings !== listed.size) fail(`${listings - listed.size} entities listed twice`);
    if (listed.size !== crates + 1) fail(`${listed.size} entities listed`);

    const pos = h.world.get(player, Transform).pos;
    const located = graph.locate(toWorld(defOf(graph, current), pos));
    if (located !== current) fail(`player in ${current} but located in ${String(located)}`);
  }
  return {
    hashes,
    playerCrossings: h.changes.filter((c) => c.entity === player).length,
    crateMoves: h.changes.filter((c) => c.entity !== player).length,
    failures,
  };
}

describe('border oscillation', () => {
  it('a player crossing a border every 30 ticks for 7200 ticks never saves a region, and crates stay whole', async () => {
    const first = await run();
    expect(first.failures).toEqual([]);
    expect(first.playerCrossings).toBe(TICKS / 30); // at tick 15, then every 30 ticks
    expect(first.crateMoves).toBeGreaterThan(100);

    const second = await run();
    expect(second.failures).toEqual([]);
    expect(second.hashes).toEqual(first.hashes);
  }, 60_000);
});

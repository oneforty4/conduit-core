import { Model, Name, Region, Transform } from '@conduit/game';
import { Rng, type Vec3 } from '@conduit/math';
import { describe, expect, it } from 'vitest';
import { SandboxLoader } from '../src/server/loader.ts';
import { Crate, Wanderer } from '../src/shared/components.ts';
import {
  CRATES_PER_REGION,
  PLACE_MAX,
  PLACE_MIN,
  SPAWN_REGION,
  WANDERER_SPEED,
  WANDERER_START,
} from '../src/shared/constants.ts';
import { game } from '../src/shared/game.ts';
import { randomGroundPoint } from '../src/shared/systems.ts';
import { SandboxSim } from './harness.ts';

/** Crate positions of `regionId`, in entity order. */
function cratesIn(s: SandboxSim, regionId: string): Vec3[] {
  return s.regions
    .entitiesIn(regionId)
    .filter((e) => s.world.has(e, Crate))
    .map((e) => ({ ...s.world.get(e, Transform).pos }));
}

async function activated(seed = game.seed): Promise<SandboxSim> {
  const s = new SandboxSim({ seed });
  await s.activateSpawn();
  return s;
}

describe('SandboxLoader', () => {
  it('fills a fresh region with 8 crates and one wanderer', async () => {
    const s = await activated();
    const { world } = s;
    const ids = s.regions.entitiesIn(SPAWN_REGION);
    expect(ids).toHaveLength(CRATES_PER_REGION + 1);
    const crates = ids.filter((e) => world.has(e, Crate));
    expect(crates).toHaveLength(CRATES_PER_REGION);
    for (const e of crates) {
      expect(world.get(e, Region).id).toBe(SPAWN_REGION);
      expect(world.get(e, Model)).toEqual({ asset: 'crate', variant: 0 });
      const pos = world.get(e, Transform).pos;
      expect(pos.y).toBe(0);
      for (const v of [pos.x, pos.z]) {
        expect(v).toBeGreaterThanOrEqual(PLACE_MIN);
        expect(v).toBeLessThan(PLACE_MAX);
      }
    }
    const wanderers = ids.filter((e) => world.has(e, Wanderer));
    expect(wanderers).toHaveLength(1);
    const w = wanderers[0] as number;
    expect(world.get(w, Region).id).toBe(SPAWN_REGION);
    expect(world.get(w, Transform).pos).toEqual({ x: WANDERER_START, y: 0, z: WANDERER_START });
    expect(world.get(w, Model)).toEqual({ asset: 'vehicle', variant: 1 });
    expect(world.get(w, Name).value).toBe('wanderer');
    expect(world.get(w, Wanderer).speed).toBe(WANDERER_SPEED);
    // Every region of the spawn neighbourhood was populated the same way.
    expect(s.regions.active()).toHaveLength(9);
    for (const id of s.regions.active()) expect(cratesIn(s, id)).toHaveLength(CRATES_PER_REGION);
  });

  it('places the same crates for the same seed, from the region stream', async () => {
    const a = await activated();
    const b = await activated();
    for (const id of a.regions.active()) expect(cratesIn(b, id)).toEqual(cratesIn(a, id));

    // The region's own stream, drawn x then z per crate, then the wanderer's first target.
    const def = a.graph.get(SPAWN_REGION);
    if (def === undefined) throw new Error('no spawn region');
    const rng = new Rng(def.seed);
    const expected = Array.from({ length: CRATES_PER_REGION }, () =>
      randomGroundPoint(rng, { x: 0, y: 0, z: 0 }),
    );
    expect(cratesIn(a, SPAWN_REGION)).toEqual(expected);
    const wanderer = a.regions.entitiesIn(SPAWN_REGION).find((e) => a.world.has(e, Wanderer));
    expect(a.world.get(wanderer as number, Wanderer).target).toEqual(
      randomGroundPoint(rng, { x: 0, y: 0, z: 0 }),
    );

    // Other regions and other world seeds get other crates.
    expect(cratesIn(a, 'cell/8_9')).not.toEqual(cratesIn(a, SPAWN_REGION));
    const other = await activated(game.seed + 1);
    expect(cratesIn(other, SPAWN_REGION)).not.toEqual(cratesIn(a, SPAWN_REGION));
  });

  it('creates nothing for a region restored from a blob, and saves no game data', () => {
    const s = new SandboxSim();
    const loader = new SandboxLoader();
    const def = s.graph.get(SPAWN_REGION);
    if (def === undefined) throw new Error('no spawn region');
    loader.populate(def, { version: 1, savedTick: 0, entities: [], rngState: 1 }, s.ctx);
    expect(s.world.count()).toBe(0);
    expect(loader.onDeactivate()).toBeUndefined();
  });
});

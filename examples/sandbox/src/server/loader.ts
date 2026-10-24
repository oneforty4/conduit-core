import { Model, Name, Region, Transform } from '@conduit/game';
import { v3 } from '@conduit/math';
import type { SimContext } from '@conduit/sim';
import type { RegionBlob, RegionDef, RegionLoader } from '@conduit/world';
import { Crate, Wanderer } from '../shared/components.ts';
import { CRATES_PER_REGION, WANDERER_SPEED, WANDERER_START } from '../shared/constants.ts';
import { randomGroundPoint } from '../shared/systems.ts';

/**
 * Procedural region content (PLAN.md "Sandbox content spec"): a fresh region gets
 * `CRATES_PER_REGION` crates and one wanderer, placed from the region's own stream, so the same
 * world seed always yields the same crates.
 */
export class SandboxLoader implements RegionLoader {
  populate(region: RegionDef, blob: RegionBlob | null, ctx: SimContext): void {
    if (blob !== null) return; // the core already restored the persisted entities (from M3)
    const { world } = ctx;
    const rng = ctx.regionRng(region.id);
    for (let i = 0; i < CRATES_PER_REGION; i++) {
      const crate = world.create();
      world.add(crate, Transform, { pos: randomGroundPoint(rng, v3.create()) });
      world.add(crate, Region, { id: region.id });
      world.add(crate, Model, { asset: 'crate', variant: 0 });
      world.add(crate, Crate, {});
    }
    const wanderer = world.create();
    world.add(wanderer, Transform, { pos: v3.create(WANDERER_START, 0, WANDERER_START) });
    world.add(wanderer, Region, { id: region.id });
    world.add(wanderer, Model, { asset: 'vehicle', variant: 1 });
    world.add(wanderer, Name, { value: 'wanderer' });
    world.add(wanderer, Wanderer, {
      target: randomGroundPoint(rng, v3.create()),
      speed: WANDERER_SPEED,
    });
  }

  /** Nothing beyond the persisted components. */
  onDeactivate(): undefined {
    return undefined;
  }
}

import { v3, type Vec3 } from '@conduit/math';
import { Region, Transform, defineSystem, type EntityId, type System } from '@conduit/sim';
import { contains, rebase, toWorld } from './coords.ts';
import type { RegionManager } from './regionManager.ts';

/**
 * The region membership system of `manager` (docs/world.md §6.1), phase `postSim`, run as the first
 * entry of `Simulation.tail` (docs/sim.md 2.9). The `RegionManager` constructor builds it as
 * `manager.membershipSystem`.
 *
 * Each pass first brings the region records up to date: entities whose `Region` was added or
 * written since the last pass are recorded, and entities destroyed this tick are pruned, so
 * `entitiesIn` never lists an entity after `applyDestroys`. Then every entity with a `Transform`
 * outside its active bounded region, and not queued for destroy, goes where `graph.locate` puts its
 * world position:
 *
 * - off the world (`null`): clamped back inside its region, then `onWorldEdge` is called;
 * - an active region: `Transform.pos` rebased onto the new origin, `Region.id` written, records
 *   updated, `RegionChanged` emitted;
 * - a loading or saving region, or an inactive one the last `update` wanted (it loads once any
 *   retry is due): it stays where it is and is tried again next tick;
 * - any other inactive region: its persisted components (position rebased) go to that region's
 *   inbox and it is destroyed; one without persisted components is just destroyed. A player entity
 *   throws `InvariantViolation`.
 *
 * Query order is ascending slot order, so simultaneous crossings resolve deterministically.
 */
export function createMembershipSystem(manager: RegionManager): System {
  const access = manager._membership;
  const { world, graph } = access;
  // Per-tick scratch, reset at the start of every run.
  const entities: EntityId[] = [];
  const dying = new Set<EntityId>(); // lookup only
  const worldPos: Vec3 = v3.create();
  const localPos: Vec3 = v3.create();

  return defineSystem('membership', 'postSim', (ctx) => {
    access.syncRecords(ctx);
    dying.clear();
    const destroyed = world.destroyedThisTick();
    for (let i = 0; i < destroyed.length; i++) dying.add(destroyed[i] as EntityId);

    world.queryInto(entities, Transform, Region);
    for (let i = 0; i < entities.length; i++) {
      const e = entities[i] as EntityId;
      const current = world.get(e, Region).id;
      const rec = access.record(current);
      if (rec === undefined || rec.state !== 'active') continue;
      const def = rec.def;
      if (def.bounds.kind === 'node') continue; // unbounded: moves only through migrate
      const pos = world.get(e, Transform).pos;
      if (contains(def, pos)) continue;
      if (dying.has(e)) continue; // going away: moving would re-record it, inboxing would resurrect it
      const target = graph.locate(toWorld(def, pos, worldPos), current);
      if (target === null) {
        access.worldEdge(e, def, ctx);
        continue;
      }
      // At a float boundary locate can return the current region for a position that contains()
      // rejects: the entity is on the border, not across it.
      if (target === current) continue;
      const trec = access.getOrCreate(target);
      switch (trec.state) {
        case 'active':
          access.relocate(e, current, trec, rebase(def, trec.def, pos, localPos), ctx.events);
          break;
        case 'loading':
        case 'saving':
          break; // tried again next tick
        case 'inactive':
          if (access.wanted(target)) break; // loads at an update soon: wait for it
          access.inbox(e, def, trec);
          break;
      }
    }
    entities.length = 0;
  });
}

import { MemoryStore } from '@conduit/persist';
import { cloneExactState, type SimContext } from '@conduit/sim';
import { describe, expect, it } from 'vitest';
import { decodeBlob, type RegionBlob, type RegionDef } from '../src/index.ts';
import { at, ControlledStore, Crate, place, rig, settle } from './rig.ts';

const content = (region: RegionDef, ctx: SimContext) => {
  ctx.world.add(place(ctx.world, region.id, at(10, 10)), Crate, { n: 3 });
};

describe('detached region captures', () => {
  it('restores exact membership, RNG, pending activations and stream bookkeeping', async () => {
    const source = rig({ content });
    await source.tick([], ['cell/0_0']);
    await source.tick([], ['cell/0_0']);
    source.regions.regionRng('cell/0_0').float();
    const world = source.world.captureCheckpoint();
    const simulation = source.sim.captureCheckpoint();
    const regions = source.regions.captureCheckpoint();
    const target = rig({ content });
    target.regions.validateCheckpoint(regions, world);
    target.world.restoreCheckpoint(world);
    target.sim.restoreCheckpoint(simulation);
    target.regions.restoreCheckpoint(regions, target.sim.ctx, { replayExternal: true });
    expect(target.regions.captureCheckpoint()).toEqual(regions);
    expect(target.world.hash()).toBe(source.world.hash());
    const malformed = cloneExactState(regions);
    malformed.records.find((record) => record.state === 'active')!.entities.push(999);
    const before = target.world.hash();
    expect(() => target.regions.validateCheckpoint(malformed, world)).toThrow('membership');
    expect(target.world.hash()).toBe(before);
  });

  it('records the exact boundary of an asynchronous load and replays it without storage I/O', async () => {
    const storage = new ControlledStore();
    const source = rig({ store: storage, content });
    await source.tick([], ['cell/0_0']);
    const world = source.world.captureCheckpoint();
    const simulation = source.sim.captureCheckpoint();
    const regions = source.regions.captureCheckpoint();
    const replayStorage = new ControlledStore();
    const target = rig({ store: replayStorage, content });
    target.world.restoreCheckpoint(world);
    target.sim.restoreCheckpoint(simulation);
    target.regions.restoreCheckpoint(regions, target.sim.ctx, { replayExternal: true });
    for (const id of ['cell/0_0', 'cell/0_1', 'cell/1_0']) storage.resolveGet(id, null);
    await settle();
    await source.tick([], ['cell/0_0']);
    for (const decision of source.regions.drainDecisions()) target.regions.injectDecision(decision);
    await target.tick([], ['cell/0_0']);
    expect(target.world.hash()).toBe(source.world.hash());
    expect(target.regions.captureCheckpoint()).toEqual(source.regions.captureCheckpoint());
    expect(replayStorage.calls).toEqual([]);
  });

  it('acknowledges only a captured inbox prefix when newer arrivals occur during writes', async () => {
    const h = rig({ store: new MemoryStore() });
    await h.tick([], ['cell/0_0']);
    await h.tick([], ['cell/0_0']);
    const send = (n: number) => {
      const entity = place(h.world, 'cell/0_0', at(10, 10));
      h.world.add(entity, Crate, { n });
      expect(h.regions.migrate(entity, 'cell/3_3', at(10, 10))).toBe('inboxed');
    };
    send(1);
    const captured = h.regions.captureSave();
    send(2);
    const arrival = captured.arrivals.find((item) => item.id === 'cell/3_3')!;
    const merged: RegionBlob = {
      version: 1,
      savedTick: captured.completedTick,
      entities: arrival.entities,
      rngState: arrival.seed,
      inboxOnly: true,
    };
    captured.acknowledge(new Map([['cell/3_3', merged]]));
    expect(h.regions.inboxSize('cell/3_3')).toBe(1);
    const next = h.regions.captureSave().arrivals.find((item) => item.id === 'cell/3_3')!;
    expect(next.base?.entities).toHaveLength(1);
    expect(next.entities).toHaveLength(1);
  });

  it('does not overwrite an activated region with an older inbox publication', async () => {
    const h = rig();
    await h.tick([], ['cell/0_0']);
    await h.tick([], ['cell/0_0']);
    const entity = place(h.world, 'cell/0_0', at(10, 10));
    h.world.add(entity, Crate, { n: 7 });
    h.regions.migrate(entity, 'cell/3_3', at(10, 10));
    const captured = h.regions.captureSave();
    await h.tick([], ['cell/3_3']);
    await h.tick([], ['cell/3_3']);
    const arrival = captured.arrivals.find((item) => item.id === 'cell/3_3')!;
    captured.acknowledge(
      new Map([
        [
          'cell/3_3',
          {
            version: 1,
            savedTick: captured.completedTick,
            entities: arrival.entities,
            rngState: arrival.seed,
            inboxOnly: true,
          },
        ],
      ]),
    );
    expect(h.regions.state('cell/3_3')).toBe('active');
    expect(h.regions.inboxSize('cell/3_3')).toBe(0);
    const active = h.regions.captureSave().writes.find((write) => write.id === 'cell/3_3')!;
    expect(decodeBlob(active.bytes)?.entities).toHaveLength(1);
  });

  it('replays recorded eviction completions without issuing new storage writes', async () => {
    const storage = new ControlledStore();
    const source = rig({ store: storage, content, lingerMs: 0 });
    await source.tick([], ['cell/0_0']);
    for (const id of ['cell/0_0', 'cell/0_1', 'cell/1_0']) storage.resolveGet(id, null);
    await settle();
    await source.tick([], ['cell/0_0']);
    await source.tick();
    const checkpoint = {
      world: source.world.captureCheckpoint(),
      simulation: source.sim.captureCheckpoint(),
      regions: source.regions.captureCheckpoint(),
    };
    const replayStorage = new ControlledStore();
    const target = rig({ store: replayStorage, content, lingerMs: 0 });
    target.world.restoreCheckpoint(checkpoint.world);
    target.sim.restoreCheckpoint(checkpoint.simulation);
    target.regions.restoreCheckpoint(checkpoint.regions, target.sim.ctx, { replayExternal: true });
    await source.tick();
    await target.tick();
    expect(() => source.regions.captureCheckpoint()).toThrow('waitForSaves');
    while (storage.pendingPuts().length > 0) {
      for (const id of storage.pendingPuts()) storage.resolvePut(id);
      await settle();
    }
    await settle();
    await source.tick();
    const decisions = source.regions.drainDecisions();
    expect(decisions.every((decision) => decision.kind === 'region-save-result')).toBe(true);
    for (const decision of decisions) target.regions.injectDecision(decision);
    await target.tick();
    expect(target.regions.captureCheckpoint()).toEqual(source.regions.captureCheckpoint());
    expect(target.world.hash()).toBe(source.world.hash());
    expect(replayStorage.calls).toEqual([]);
  });
});

import { Region, type EntityId } from '@conduit/sim';
import { Group } from 'three';
import { describe, expect, it, vi } from 'vitest';
import {
  NULL_INPUT,
  type Binder,
  type CameraContext,
  type CameraController,
  type EntityView,
  type InputSource,
} from '../src/index.ts';
import { FIXTURE_CELL_SIZE, comp, createWorld, regionOf, transformAt } from './replica-fixture.ts';

const DT = 1 / 60;

function ids(views: Iterable<EntityView>): EntityId[] {
  return [...views].map((v) => v.id);
}

class RecordingCamera implements CameraController {
  readonly calls: string[] = [];
  readonly contexts: CameraContext[] = [];
  readonly targets: (EntityView | null)[] = [];

  attach(ctx: CameraContext): void {
    this.calls.push('attach');
    this.contexts.push(ctx);
    this.targets.push(ctx.target);
  }

  update(dt: number, ctx: CameraContext): void {
    this.calls.push(`update ${dt}`);
    expect(ctx.dt).toBe(dt);
    this.contexts.push(ctx);
    this.targets.push(ctx.target);
  }

  detach(): void {
    this.calls.push('detach');
  }
}

describe('RenderWorld view lifecycle', () => {
  it('a view exists exactly while createdTick <= renderTick < destroyedTick', () => {
    const { fixture, world } = createWorld();
    const E = 7;
    fixture.snapshot(10, {
      creates: [
        { entity: E, components: [regionOf('cell/1_2'), transformAt({ x: 1, y: 0, z: 2 })] },
      ],
    });

    fixture.setRenderTick(9);
    world.update(DT);
    expect(world.renderTick).toBe(9);
    expect(world.view(E)).toBeUndefined();
    fixture.setRenderTick(9.5);
    world.update(DT);
    expect(world.view(E)).toBeUndefined();

    fixture.setRenderTick(10);
    world.update(DT);
    expect(world.renderTick).toBe(10);
    const view = world.view(E);
    expect(view).toBeDefined();
    expect(view!.id).toBe(E);

    fixture.snapshot(20, { destroys: [E] });
    fixture.setRenderTick(19);
    world.update(DT);
    expect(world.view(E)).toBe(view);
    fixture.setRenderTick(19.95);
    world.update(DT);
    expect(world.view(E)).toBe(view);

    fixture.setRenderTick(20);
    world.update(DT);
    expect(world.view(E)).toBeUndefined();
    expect(ids(world.views())).toEqual([]);
    expect(view!.object.parent).toBeNull();

    // A render clock that falls back inside the lifetime shows the entity again (a new view).
    fixture.setRenderTick(15);
    world.update(DT);
    expect(world.view(E)).toBeDefined();
    expect(world.view(E)).not.toBe(view);
  });

  it('views are named entity:<id> and parented to regionGroup(Region.id) at the region origin', () => {
    const { fixture, host, world } = createWorld();
    fixture.snapshot(3, {
      creates: [
        { entity: 1, components: [regionOf('cell/0_0')] },
        { entity: 2, components: [regionOf('cell/1_2'), transformAt({ x: 5, y: 0, z: 6 })] },
      ],
    });
    fixture.setRenderTick(3);
    world.update(DT);

    expect(world.root.name).toBe('conduit-root');
    expect(world.root.parent).toBe(host.scene);
    const a = world.view(1)!;
    const b = world.view(2)!;
    expect(a.object.name).toBe('entity:1');
    expect(b.object.name).toBe('entity:2');
    expect(a.regionId).toBe('cell/0_0');
    expect(b.regionId).toBe('cell/1_2');
    expect(a.object.parent).toBe(world.regionGroup('cell/0_0'));
    expect(b.object.parent).toBe(world.regionGroup('cell/1_2'));
    expect(a.data).toEqual({});
    expect(a.attached.size).toBe(0);
    expect(a.model).toBeUndefined();

    const group = world.regionGroup('cell/1_2');
    expect(group.name).toBe('region:cell/1_2');
    expect(group.userData['regionId']).toBe('cell/1_2');
    expect(group.parent).toBe(world.root);
    expect(group.position.toArray()).toEqual([FIXTURE_CELL_SIZE, 0, 2 * FIXTURE_CELL_SIZE]);
    expect(world.floatingOrigin).toEqual({ x: 0, y: 0, z: 0 });
    expect(world.floatingRegion).toBeNull();
  });

  it("worldOf is a view's region origin plus its position; toWorld and toScene add and take away the floating origin", () => {
    const { fixture, world } = createWorld();
    fixture.snapshot(3, {
      creates: [
        { entity: 2, components: [regionOf('cell/1_2'), transformAt({ x: 5, y: 0, z: 6 })] },
      ],
    });
    fixture.setRenderTick(3);
    world.update(DT);
    const view = world.view(2)!;
    view.object.position.set(5, 1, 6);
    const out = { x: 0, y: 0, z: 0 };
    expect(world.worldOf(view, out)).toBe(out);
    expect(out).toEqual({ x: FIXTURE_CELL_SIZE + 5, y: 1, z: 2 * FIXTURE_CELL_SIZE + 6 });
    world.setFloatingOrigin('cell/1_2');
    const point = { x: FIXTURE_CELL_SIZE + 3, y: 2, z: 2 * FIXTURE_CELL_SIZE - 4 };
    expect(world.toScene(point, { x: 0, y: 0, z: 0 })).toEqual({ x: 3, y: 2, z: -4 });
    expect(world.toWorld({ x: 3, y: 2, z: -4 }, { x: 0, y: 0, z: 0 })).toEqual(point);
  });

  it('an entity without a Region component uses the region of its create', () => {
    const { fixture, world } = createWorld();
    fixture.snapshot(3, { creates: [{ entity: 4, region: 'cell/2_1', components: [] }] });
    fixture.setRenderTick(3);
    world.update(DT);
    expect(world.view(4)?.object.parent).toBe(world.regionGroup('cell/2_1'));
  });

  it('an entity with no region at all is a RangeError while no floating origin is set', () => {
    const { fixture, world } = createWorld();
    fixture.snapshot(3, { creates: [{ entity: 4, components: [] }] });
    fixture.setRenderTick(3);
    expect(() => world.update(DT)).toThrow(RangeError);
    expect(world.view(4)).toBeUndefined();
  });

  it('regionGroup creates on demand, returns the same group after, and rejects unknown ids', () => {
    const { world } = createWorld();
    expect(world.hasRegionGroup('cell/3_3')).toBe(false);
    const g = world.regionGroup('cell/3_3');
    expect(world.hasRegionGroup('cell/3_3')).toBe(true);
    expect(world.regionGroup('cell/3_3')).toBe(g);
    expect(world.root.children).toEqual([g]);
    expect(() => world.regionGroup('cell/4_0')).toThrow(RangeError);
    expect(() => world.regionGroup('nowhere')).toThrow(RangeError);
    expect(world.hasRegionGroup('nowhere')).toBe(false);
  });

  it('releaseRegionGroup removes a group without views and is a no-op otherwise', () => {
    const { fixture, world } = createWorld();
    const empty = world.regionGroup('cell/2_2');
    const scenery = new Group();
    empty.add(scenery);
    fixture.snapshot(3, { creates: [{ entity: 1, components: [regionOf('cell/1_1')] }] });
    fixture.setRenderTick(3);
    world.update(DT);
    const occupied = world.regionGroup('cell/1_1');

    world.releaseRegionGroup('cell/2_2');
    expect(world.hasRegionGroup('cell/2_2')).toBe(false);
    expect(empty.parent).toBeNull();
    expect(scenery.parent).toBe(empty); // non-view children leave with the group
    expect(world.root.children).toEqual([occupied]);

    world.releaseRegionGroup('cell/1_1'); // view 1 is in it
    world.releaseRegionGroup('cell/3_3'); // no group
    world.releaseRegionGroup('nowhere'); // unknown id: nothing to release, no RangeError
    expect(world.hasRegionGroup('cell/1_1')).toBe(true);
    expect(occupied.parent).toBe(world.root);
    expect(world.view(1)?.object.parent).toBe(occupied);

    const again = world.regionGroup('cell/2_2');
    expect(again).not.toBe(empty);
    expect(again.parent).toBe(world.root);
    expect(again.position.toArray()).toEqual([2 * FIXTURE_CELL_SIZE, 0, 2 * FIXTURE_CELL_SIZE]);

    fixture.snapshot(6, { destroys: [1] });
    fixture.setRenderTick(6);
    world.update(DT);
    world.releaseRegionGroup('cell/1_1');
    expect(world.hasRegionGroup('cell/1_1')).toBe(false);
    expect(occupied.parent).toBeNull();
    expect(world.root.children).toEqual([again]);
  });

  it('an unknown Region.id is a RangeError and creates no view', () => {
    const { fixture, world } = createWorld();
    fixture.snapshot(3, { creates: [{ entity: 4, components: [regionOf('cell/9_9')] }] });
    fixture.setRenderTick(3);
    expect(() => world.update(DT)).toThrow(RangeError);
    expect(world.view(4)).toBeUndefined();
  });

  it('views() iterates in ascending entity id', () => {
    const { fixture, world } = createWorld();
    fixture.snapshot(3, {
      creates: [30, 5, 17, 0x80000001].map((entity) => ({
        entity,
        components: [regionOf('cell/0_0')],
      })),
    });
    fixture.setRenderTick(3);
    world.update(DT);
    expect(ids(world.views())).toEqual([5, 17, 30, 0x80000001]);
  });

  it('emits viewCreated and viewDestroyed', () => {
    const { fixture, world } = createWorld();
    const events: string[] = [];
    world.on('viewCreated', ({ view }) => {
      expect(world.view(view.id)).toBe(view);
      events.push(`created ${view.id}`);
    });
    const off = world.on('viewDestroyed', ({ view }) => {
      expect(world.view(view.id)).toBeUndefined();
      expect(view.object.parent).toBeNull();
      events.push(`destroyed ${view.id}`);
    });
    fixture.snapshot(3, {
      creates: [
        { entity: 2, components: [regionOf('cell/0_0')] },
        { entity: 1, components: [regionOf('cell/0_0')] },
      ],
    });
    fixture.setRenderTick(3);
    world.update(DT);
    world.update(DT);
    fixture.snapshot(6, { destroys: [1] });
    fixture.setRenderTick(6);
    world.update(DT);
    expect(events).toEqual(['created 2', 'created 1', 'destroyed 1']);

    off();
    off();
    fixture.snapshot(9, { destroys: [2] });
    fixture.setRenderTick(9);
    world.update(DT);
    expect(events).toEqual(['created 2', 'created 1', 'destroyed 1']);
    expect(world.view(2)).toBeUndefined();
  });

  it('never calls ReplicaWorld.gc, so destroyed entities stay in the replica', () => {
    const { fixture, world, host, frames } = createWorld();
    const gc = vi.spyOn(fixture.replica, 'gc');
    fixture.snapshot(3, { creates: [{ entity: 9, components: [regionOf('cell/0_0')] }] });
    fixture.snapshot(6, { destroys: [9] });
    host.setWorld(world);
    host.start();
    for (const tick of [3, 5, 6, 30, 1000]) {
      fixture.setRenderTick(tick);
      world.update(DT);
      frames.stepFrame();
    }
    world.dispose();
    expect(gc).not.toHaveBeenCalled();
    expect(fixture.replica.has(9)).toBe(true);
  });

  it('removing Region keeps the view in its group (re-parenting is RegionBinder, M3)', () => {
    const { fixture, world } = createWorld();
    fixture.snapshot(3, { creates: [{ entity: 3, components: [regionOf('cell/1_1')] }] });
    fixture.setRenderTick(3);
    world.update(DT);
    fixture.snapshot(6, { updates: [{ entity: 3, removed: [Region] }] });
    fixture.setRenderTick(6);
    world.update(DT);
    expect(world.view(3)?.object.parent).toBe(world.regionGroup('cell/1_1'));
  });
});

describe('RenderWorld camera wiring', () => {
  it('setCamera attaches with the context; update passes dt and the target view', () => {
    const { fixture, world, host } = createWorld();
    const cam = new RecordingCamera();
    world.cameraTarget(8);
    world.setCamera(cam);
    expect(cam.calls).toEqual(['attach']);
    const ctx = cam.contexts[0]!;
    expect(ctx.camera).toBe(host.camera);
    expect(ctx.world).toBe(world);
    expect(ctx.input).toBe(NULL_INPUT);
    expect(ctx.target).toBeNull();

    world.update(0.25); // no view for 8 yet
    expect(cam.targets.at(-1)).toBeNull();

    fixture.snapshot(3, { creates: [{ entity: 8, components: [regionOf('cell/0_0')] }] });
    fixture.setRenderTick(3);
    world.update(0.5);
    expect(cam.calls).toEqual(['attach', 'update 0.25', 'update 0.5']);
    expect(cam.targets.at(-1)).toBe(world.view(8));
    expect(cam.contexts.every((c) => c === ctx)).toBe(true);

    const input: InputSource = { ...NULL_INPUT, isKeyDown: (code) => code === 'KeyW' };
    world.setInput(input);
    world.cameraTarget(null);
    expect(ctx.target).toBeNull();
    world.update(DT);
    expect(ctx.input).toBe(input);
    expect(cam.targets.at(-1)).toBeNull();

    world.cameraTarget(8);
    expect(ctx.target).toBe(world.view(8));
  });

  it('setCamera detaches the previous controller before attaching the next; null detaches', () => {
    const { fixture, world } = createWorld();
    fixture.snapshot(3, { creates: [{ entity: 8, components: [regionOf('cell/0_0')] }] });
    fixture.setRenderTick(3);
    world.update(DT);
    world.cameraTarget(8);
    const log: string[] = [];
    const a = new RecordingCamera();
    const b = new RecordingCamera();
    a.detach = () => log.push('a detach');
    b.attach = (ctx) => {
      log.push(`b attach ${ctx.target?.id}`);
    };
    world.setCamera(a);
    world.setCamera(b);
    expect(log).toEqual(['a detach', 'b attach 8']);
    world.setCamera(null);
    world.update(DT);
    expect(b.calls).toEqual(['detach']);
  });

  it('the camera sees views after binders ran and after destroyed views are gone', () => {
    const { fixture, world } = createWorld();
    const seen: string[] = [];
    const binder: Binder<{ id: string }> = {
      component: Region,
      onUpdate: (view) => seen.push(`binder ${view.id}`),
    };
    world.registerBinder(binder);
    world.cameraTarget(1);
    world.setCamera({
      attach: () => {},
      detach: () => {},
      update: (_dt, ctx) => seen.push(`camera ${ctx.target?.id} views ${ids(world.views())}`),
    });
    fixture.snapshot(3, {
      creates: [
        { entity: 1, components: [regionOf('cell/0_0')] },
        { entity: 2, components: [regionOf('cell/0_0')] },
      ],
    });
    fixture.snapshot(6, { destroys: [2] });
    fixture.setRenderTick(3);
    world.update(DT);
    fixture.setRenderTick(6);
    world.update(DT);
    expect(seen).toEqual([
      'binder 1',
      'binder 2',
      'camera 1 views 1,2',
      'binder 1',
      'camera 1 views 1',
    ]);
  });
});

describe('RenderWorld.dispose', () => {
  it('detaches binders, destroys views, detaches the camera and removes the root', () => {
    const { fixture, world, host } = createWorld();
    const log: string[] = [];
    world.registerBinder({
      component: Region,
      onDetach: (view) => log.push(`detach ${view.id}`),
    });
    world.on('viewDestroyed', ({ view }) => log.push(`destroyed ${view.id}`));
    const cam = new RecordingCamera();
    world.setCamera(cam);
    fixture.snapshot(3, {
      creates: [
        { entity: 2, components: [regionOf('cell/0_0')] },
        { entity: 1, components: [comp(Region, { id: 'cell/1_0' })] },
      ],
    });
    fixture.setRenderTick(3);
    world.update(DT);
    const views = [...world.views()];

    world.dispose();
    expect(log).toEqual(['detach 1', 'destroyed 1', 'detach 2', 'destroyed 2']);
    expect(cam.calls.at(-1)).toBe('detach');
    expect(world.root.parent).toBeNull();
    expect(host.scene.children).not.toContain(world.root);
    expect(ids(world.views())).toEqual([]);
    expect(views.every((v) => v.object.parent === null && v.attached.size === 0)).toBe(true);
    expect(world.hasRegionGroup('cell/0_0')).toBe(false);

    world.update(DT); // no-op
    world.dispose();
    expect(ids(world.views())).toEqual([]);
    expect(log).toHaveLength(4);
  });

  it('does not update a binder after its attach callback disposes the world', () => {
    const { fixture, world } = createWorld();
    const calls: string[] = [];
    world.registerBinder({
      component: Region,
      onAttach: () => {
        calls.push('attach');
        world.dispose();
      },
      onDetach: () => {
        calls.push('detach');
      },
      onUpdate: () => {
        calls.push('update');
      },
    });
    fixture.snapshot(3, { creates: [{ entity: 1, components: [regionOf('cell/0_0')] }] });
    fixture.setRenderTick(3);
    world.update(DT);
    expect(calls).toEqual(['attach', 'detach']);
    expect([...world.views()]).toEqual([]);
  });
  it('does not update a binder that unregisters itself during attach', () => {
    const { fixture, world } = createWorld();
    const calls: string[] = [];
    let off = () => {};
    off = world.registerBinder({
      component: Region,
      onAttach: () => {
        calls.push('attach');
        off();
      },
      onDetach: () => {
        calls.push('detach');
      },
      onUpdate: () => {
        calls.push('update');
      },
    });
    fixture.snapshot(3, { creates: [{ entity: 1, components: [regionOf('cell/0_0')] }] });
    fixture.setRenderTick(3);
    world.update(DT);
    expect(calls).toEqual(['attach', 'detach']);
    world.dispose();
  });
  it('dispose from a viewCreated listener stops the update creating further views', () => {
    const { fixture, world } = createWorld();
    const created: number[] = [];
    world.on('viewCreated', ({ view }) => {
      created.push(view.id);
      world.dispose();
    });
    fixture.snapshot(3, {
      creates: [1, 2, 3].map((entity) => ({ entity, components: [regionOf('cell/0_0')] })),
    });
    fixture.setRenderTick(3);
    world.update(DT);
    expect(created).toEqual([1]);
    expect(ids(world.views())).toEqual([]);
    expect(world.root.parent).toBeNull();
  });
});

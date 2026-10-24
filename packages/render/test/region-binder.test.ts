import type { Vec3 } from '@conduit/math';
import { Region, Transform } from '@conduit/sim';
import type { RegionId } from '@conduit/world';
import { Group, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  FollowCamera,
  RegionBinder,
  regionFrameOffset,
  TransformBinder,
  type CameraController,
  type EntityView,
  type RenderWorld,
} from '../src/index.ts';
import {
  comp,
  createWorld,
  FIXTURE_CELL_SIZE,
  FIXTURE_SNAPSHOT_EVERY,
  FIXTURE_TICK_RATE,
  regionOf,
  ReplicaFixture,
  transformAt,
  type WorldSetup,
} from './replica-fixture.ts';

const DT = 1 / 60;
const CELL = FIXTURE_CELL_SIZE;
/** m/s along +x. */
const SPEED = 18;
const PER_TICK = SPEED / FIXTURE_TICK_RATE;
/** Render frames every 0.75 ticks (15 ms): exact in binary, so `setRenderTick` hits every value. */
const FRAME_TICKS = 0.75;
/** How far the render tick lags the newest snapshot (about the 7 ticks of docs/net.md B.1). */
const DELAY_TICKS = 7;
const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };

/** A `RenderWorld` with the core region and transform binders, in `createClient` order. */
function setup(fixture = new ReplicaFixture()): WorldSetup {
  const s = createWorld(fixture);
  s.world.registerBinder(new RegionBinder(s.world));
  s.world.registerBinder(new TransformBinder());
  return s;
}

const scratch = new Vector3();

/** The view's world-space position: scene position plus the floating origin. */
function worldPosition(world: RenderWorld, view: EntityView): Vec3 {
  view.object.getWorldPosition(scratch);
  const o = world.floatingOrigin;
  return { x: scratch.x + o.x, y: scratch.y + o.y, z: scratch.z + o.z };
}

function originOf(world: RenderWorld, id: RegionId): Vec3 {
  return world.graph.get(id)!.bounds.origin;
}

function expectVec(actual: Vec3, want: Vec3, digits = 6): void {
  expect(actual.x).toBeCloseTo(want.x, digits);
  expect(actual.y).toBeCloseTo(want.y, digits);
  expect(actual.z).toBeCloseTo(want.z, digits);
}

/**
 * The server side of entity 1 moving along `path` (world space, by tick) through the fixture graph,
 * as the membership system replicates it: region-local `Transform` every snapshot, `Region` on create
 * and whenever it changes (docs/world.md §6.1).
 */
class Drive {
  private region: RegionId | null = null;
  private tick = 0;

  constructor(
    private readonly fixture: ReplicaFixture,
    private readonly path: (tick: number) => Vec3,
  ) {}

  /** A straight drive along +x at `SPEED` from `start` (the position at tick 0). */
  static straight(fixture: ReplicaFixture, start: Vec3): Drive {
    return new Drive(fixture, (tick) => ({ x: start.x + PER_TICK * tick, y: start.y, z: start.z }));
  }

  /**
   * Where the client should show the entity at `renderTick`: the blend of the world positions of
   * the bracketing snapshots (the path itself for a straight drive).
   */
  expectedAt(renderTick: number): Vec3 {
    const a = Math.floor(renderTick / FIXTURE_SNAPSHOT_EVERY) * FIXTURE_SNAPSHOT_EVERY;
    const t = (renderTick - a) / FIXTURE_SNAPSHOT_EVERY;
    const pa = this.path(a);
    const pb = this.path(a + FIXTURE_SNAPSHOT_EVERY);
    return {
      x: pa.x + (pb.x - pa.x) * t,
      y: pa.y + (pb.y - pa.y) * t,
      z: pa.z + (pb.z - pa.z) * t,
    };
  }

  /** Applies every snapshot with a tick `<= upTo` not applied yet, in tick order. */
  arrive(upTo: number): void {
    const graph = this.fixture.graph;
    while (this.tick + FIXTURE_SNAPSHOT_EVERY <= upTo) {
      const tick = this.tick + FIXTURE_SNAPSHOT_EVERY;
      const p = this.path(tick);
      const region = graph.locate(p);
      if (region === null) throw new Error(`Drive: left the world at tick ${tick}`);
      const o = graph.get(region)!.bounds.origin;
      const local = { x: p.x - o.x, y: p.y - o.y, z: p.z - o.z };
      const components = [transformAt(local, IDENTITY, { x: SPEED, y: 0, z: 0 })];
      if (region !== this.region) components.push(regionOf(region));
      if (this.region === null)
        this.fixture.snapshot(tick, { creates: [{ entity: 1, components }] });
      else this.fixture.snapshot(tick, { updates: [{ entity: 1, components }] });
      this.region = region;
      this.tick = tick;
    }
  }
}

describe('RegionBinder', () => {
  it('re-parents the view to the new group when the render tick reaches the migration, keeping its local position', () => {
    const { fixture, world } = setup();
    fixture.snapshot(3, {
      creates: [
        { entity: 1, components: [regionOf('cell/1_1'), transformAt({ x: 10, y: 0, z: 20 })] },
      ],
    });
    fixture.setRenderTick(3);
    world.update(DT);
    const view = world.view(1)!;
    expect(view.regionId).toBe('cell/1_1');
    expect(view.object.parent).toBe(world.regionGroup('cell/1_1'));

    // A migration that keeps the local coordinates (RegionManager.migrate with newLocalPos).
    fixture.snapshot(6, {
      updates: [
        { entity: 1, components: [regionOf('cell/2_1'), transformAt({ x: 10, y: 0, z: 20 })] },
      ],
    });
    world.update(DT); // the render tick is still 3: the new region applies from sample 6
    expect(view.regionId).toBe('cell/1_1');
    expect(view.object.parent).toBe(world.regionGroup('cell/1_1'));
    expect(view.object.position.toArray()).toEqual([10, 0, 20]);

    fixture.setRenderTick(6);
    world.update(DT);
    expect(view.regionId).toBe('cell/2_1');
    expect(view.object.parent).toBe(world.regionGroup('cell/2_1'));
    expect(view.object.position.toArray()).toEqual([10, 0, 20]);
    expect(regionFrameOffset(view)).toEqual({ x: 0, y: 0, z: 0 });
    expect(world.regionGroup('cell/1_1').children).toEqual([]);
    expect(worldPosition(world, view)).toEqual({ x: 2 * CELL + 10, y: 0, z: CELL + 20 });
  });

  it('blends in world space between the last sample in the old region and the first in the new one', () => {
    const { fixture, world } = setup();
    fixture.snapshot(3, {
      creates: [
        { entity: 1, components: [regionOf('cell/1_1'), transformAt({ x: 10, y: 0, z: 20 })] },
      ],
    });
    fixture.setRenderTick(3);
    world.update(DT);
    fixture.snapshot(6, {
      updates: [
        { entity: 1, components: [regionOf('cell/2_1'), transformAt({ x: 10, y: 0, z: 20 })] },
      ],
    });
    fixture.setRenderTick(4.5);
    world.update(DT);
    const view = world.view(1)!;
    // World x goes 266 -> 522 between the samples; halfway, shown in the old region's group.
    expect(view.regionId).toBe('cell/1_1');
    expect(regionFrameOffset(view)).toEqual({ x: CELL / 2, y: 0, z: 0 });
    expect(view.object.position.toArray()).toEqual([10 + CELL / 2, 0, 20]);
    expect(worldPosition(world, view)).toEqual({ x: CELL + 10 + CELL / 2, y: 0, z: CELL + 20 });

    fixture.setRenderTick(3);
    world.update(DT);
    expect(view.regionId).toBe('cell/1_1');
    expect(view.object.position.toArray()).toEqual([10, 0, 20]);
  });

  it('a Region written without Transform moves the newest sample into the new region at once', () => {
    const { fixture, world } = setup();
    fixture.snapshot(3, {
      creates: [
        { entity: 1, components: [regionOf('cell/1_1'), transformAt({ x: 10, y: 0, z: 20 })] },
      ],
    });
    fixture.setRenderTick(3);
    world.update(DT);
    fixture.snapshot(6, { updates: [{ entity: 1, components: [regionOf('cell/1_2')] }] });
    world.update(DT);
    const view = world.view(1)!;
    expect(view.regionId).toBe('cell/1_2');
    expect(view.object.parent).toBe(world.regionGroup('cell/1_2'));
    expect(view.object.position.toArray()).toEqual([10, 0, 20]);
  });

  it('a Region written after its Transform was removed moves it at once', () => {
    const { fixture, world } = setup();
    fixture.snapshot(3, {
      creates: [
        { entity: 1, components: [regionOf('cell/1_1'), transformAt({ x: 10, y: 0, z: 20 })] },
      ],
    });
    fixture.setRenderTick(3);
    world.update(DT);
    // Its samples still hold where it was, and that it went: nothing to time the move by.
    fixture.snapshot(6, { updates: [{ entity: 1, removed: [Transform] }] });
    fixture.snapshot(9, { updates: [{ entity: 1, components: [regionOf('cell/1_2')] }] });
    fixture.setRenderTick(9);
    world.update(DT);
    const view = world.view(1)!;
    expect(view.regionId).toBe('cell/1_2');
    expect(view.object.parent).toBe(world.regionGroup('cell/1_2'));
  });

  it('onAttach re-parents a view created under its create region; onDetach leaves it in place', () => {
    const { fixture, world } = setup();
    fixture.snapshot(3, { creates: [{ entity: 4, region: 'cell/0_0', components: [] }] });
    fixture.setRenderTick(3);
    world.update(DT);
    const view = world.view(4)!;
    expect(view.object.parent).toBe(world.regionGroup('cell/0_0'));

    fixture.snapshot(6, { updates: [{ entity: 4, components: [regionOf('cell/3_2')] }] });
    world.update(DT);
    expect(view.regionId).toBe('cell/3_2');
    expect(view.object.parent).toBe(world.regionGroup('cell/3_2'));
    expect(view.data['__region']).toBeDefined();

    fixture.snapshot(9, { updates: [{ entity: 4, removed: [Region] }] });
    world.update(DT);
    expect(view.attached.size).toBe(0);
    expect(view.regionId).toBe('cell/3_2');
    expect(view.object.parent).toBe(world.regionGroup('cell/3_2'));
    expect(view.data).toEqual({});
    expect(regionFrameOffset(view)).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('an unknown Region.id is a RangeError and leaves the view where it was', () => {
    const { fixture, world } = setup();
    fixture.snapshot(3, { creates: [{ entity: 1, components: [regionOf('cell/1_1')] }] });
    fixture.setRenderTick(3);
    world.update(DT);
    fixture.snapshot(6, { updates: [{ entity: 1, components: [regionOf('cell/5_5')] }] });
    fixture.setRenderTick(6);
    expect(() => world.update(DT)).toThrow(RangeError);
    expect(world.view(1)!.regionId).toBe('cell/1_1');
    expect(world.view(1)!.object.parent).toBe(world.regionGroup('cell/1_1'));
  });

  it('keeps the world position continuous across a border while the render tick lags the snapshots, floating origin elsewhere', () => {
    const { fixture, world } = setup();
    world.setFloatingOrigin('cell/0_3');
    // x = 500 + 0.36 * tick crosses into cell/2_1 at tick 33.3; sample 33 is local to cell/1_1, 36 to cell/2_1.
    const drive = Drive.straight(fixture, { x: 500, y: 0, z: CELL + 100 });
    const shown: string[] = [];
    let previous: Vec3 | null = null;
    let maxStep = 0;
    for (let rt = 3; rt <= 45; rt += FRAME_TICKS) {
      drive.arrive(rt + DELAY_TICKS);
      fixture.setRenderTick(rt);
      world.update(DT);
      const view = world.view(1)!;
      const p = worldPosition(world, view);
      expectVec(p, drive.expectedAt(rt));
      expect(view.object.parent).toBe(world.regionGroup(view.regionId));
      const straddling = rt > 33 && rt < 36;
      expect(regionFrameOffset(view).x).toBeCloseTo(straddling ? (CELL * (rt - 33)) / 3 : 0, 9);
      if (!shown.at(-1)?.endsWith(view.regionId)) shown.push(`${rt} ${view.regionId}`);
      if (previous !== null) maxStep = Math.max(maxStep, Math.abs(p.x - previous.x));
      previous = p;
    }
    // The latest Region.id changed when snapshot 36 arrived at render tick 29.
    expect(shown).toEqual(['3 cell/1_1', '36 cell/2_1']);
    expect(maxStep).toBeLessThanOrEqual(PER_TICK * FRAME_TICKS + 1e-6);
    expect(maxStep).toBeGreaterThan(PER_TICK * FRAME_TICKS - 1e-6);
  });

  it('follows an entity zig-zagging across a border, changing region every one or two snapshots', () => {
    const { fixture, world } = setup();
    world.setFloatingOrigin('cell/3_3');
    // At rest at x = 515 until the view exists, then x = 512 + 3 * sin(tick * π / 6): samples at
    // 515, 512, 509, 512, ... (512 is in cell/2_1), so cell/1_1 lasts one sample. (A view created
    // after a migration it has not rendered yet cannot know the older region, docs/render.md §4.2.)
    const swing = [0, 3, 0, -3];
    const drive = new Drive(fixture, (tick) => ({
      x: 2 * CELL + (tick <= 12 ? 3 : (swing[(tick / FIXTURE_SNAPSHOT_EVERY) % 4] ?? 0)),
      y: 0,
      z: CELL + 100,
    }));
    const regions = new Set<RegionId>();
    let previous: Vec3 | null = null;
    for (let rt = 3; rt <= 60; rt += FRAME_TICKS) {
      drive.arrive(rt + DELAY_TICKS);
      fixture.setRenderTick(rt);
      world.update(DT);
      const view = world.view(1)!;
      const p = worldPosition(world, view);
      expectVec(p, drive.expectedAt(rt));
      expect(view.object.parent).toBe(world.regionGroup(view.regionId));
      regions.add(view.regionId);
      // one step is at most a quarter of a swing between samples: 3 m over 3 ticks
      if (previous !== null) expect(Math.abs(p.x - previous.x)).toBeLessThanOrEqual(0.75 + 1e-6);
      previous = p;
    }
    expect([...regions].sort()).toEqual(['cell/1_1', 'cell/2_1']);
  });

  it.each([
    { resume: 34.5, why: 'the crossing among several new samples' },
    { resume: 60, why: 'every sample before the crossing already evicted' },
  ])('finds the migration sample when snapshots piled up during a stall ($why)', ({ resume }) => {
    const { fixture, world } = setup();
    world.setFloatingOrigin('cell/3_0');
    const drive = Drive.straight(fixture, { x: 500, y: 0, z: CELL + 100 });
    const frame = (rt: number): Vec3 => {
      drive.arrive(rt + DELAY_TICKS);
      fixture.setRenderTick(rt);
      world.update(DT);
      const p = worldPosition(world, world.view(1)!);
      expectVec(p, drive.expectedAt(rt));
      return p;
    };
    for (let rt = 3; rt <= 20.25; rt += FRAME_TICKS) frame(rt);
    // No frames for a while (a background tab): the snapshots up to resume + 7 arrive together.
    let previous = frame(resume);
    expect(world.view(1)!.regionId).toBe(resume < 36 ? 'cell/1_1' : 'cell/2_1');
    for (let rt = resume + FRAME_TICKS; rt <= resume + 12; rt += FRAME_TICKS) {
      const p = frame(rt);
      expect(Math.abs(p.x - previous.x)).toBeLessThanOrEqual(PER_TICK * FRAME_TICKS + 1e-6);
      previous = p;
    }
    expect(world.view(1)!.regionId).toBe('cell/2_1');
  });

  it('a FollowCamera sees the same world-space motion whether or not the floating origin follows the entity', () => {
    const fixture = new ReplicaFixture();
    const fixed = setup(fixture);
    const moving = setup(fixture);
    fixed.world.setFloatingOrigin('cell/0_3');
    for (const { world } of [fixed, moving]) {
      world.setCamera(new FollowCamera());
      world.cameraTarget(1);
    }
    const origins: RegionId[] = [];
    moving.world.on('floatingOrigin', ({ regionId }) => origins.push(regionId));
    const drive = Drive.straight(fixture, { x: 500, y: 0, z: CELL + 100 });
    const cameraWorld = ({ world, host }: WorldSetup): Vec3 => {
      const o = world.floatingOrigin;
      const p = host.camera.position;
      return { x: p.x + o.x, y: p.y + o.y, z: p.z + o.z };
    };
    for (let rt = 3; rt <= 45; rt += FRAME_TICKS) {
      drive.arrive(rt + DELAY_TICKS);
      fixture.setRenderTick(rt);
      // createClient: the floating origin follows the local entity's latest Region.id (docs/game.md §4).
      const latest = fixture.replica.read(1, Region)?.id;
      if (latest !== undefined && latest !== moving.world.floatingRegion) {
        moving.world.setFloatingOrigin(latest);
      }
      fixed.world.update(DT);
      moving.world.update(DT);
      expectVec(cameraWorld(moving), cameraWorld(fixed));
      const q = moving.host.camera.quaternion.toArray();
      fixed.host.camera.quaternion.toArray().forEach((v, i) => expect(q[i]).toBeCloseTo(v, 9));
      expectVec(
        worldPosition(moving.world, moving.world.view(1)!),
        worldPosition(fixed.world, fixed.world.view(1)!),
      );
    }
    expect(origins).toEqual(['cell/1_1', 'cell/2_1']);
    // The spring caught up with the car: the camera did move with it across the border.
    expect(cameraWorld(moving).x).toBeGreaterThan(512);
  });
});

describe('RenderWorld.setFloatingOrigin', () => {
  it('places every group at origin - floatingOrigin, keeps views local and emits floatingOrigin after moving them', () => {
    const { fixture, world } = setup();
    fixture.snapshot(3, {
      creates: [
        { entity: 1, components: [regionOf('cell/1_2'), transformAt({ x: 1, y: 2, z: 3 })] },
        { entity: 2, components: [regionOf('cell/3_0'), transformAt({ x: 4, y: 5, z: 6 })] },
      ],
    });
    fixture.setRenderTick(3);
    world.update(DT);
    const views = [world.view(1)!, world.view(2)!];
    const before = views.map((v) => worldPosition(world, v));
    const expectPlaced = (): void => {
      for (const id of ['cell/1_2', 'cell/3_0', 'cell/0_0']) {
        if (!world.hasRegionGroup(id)) continue;
        const o = originOf(world, id);
        const f = world.floatingOrigin;
        expect(world.regionGroup(id).position.toArray()).toEqual([o.x - f.x, o.y - f.y, o.z - f.z]);
      }
    };
    const events: { regionId: RegionId; origin: Vec3 }[] = [];
    world.on('floatingOrigin', (e) => {
      expectPlaced();
      events.push(e);
    });

    world.setFloatingOrigin('cell/2_1');
    expect(world.floatingOrigin).toEqual({ x: 2 * CELL, y: 0, z: CELL });
    expect(world.floatingRegion).toBe('cell/2_1');
    expect(world.regionGroup('cell/1_2').position.toArray()).toEqual([-CELL, 0, CELL]);
    expect(world.regionGroup('cell/3_0').position.toArray()).toEqual([CELL, 0, -CELL]);
    expect(events).toEqual([{ regionId: 'cell/2_1', origin: { x: 2 * CELL, y: 0, z: CELL } }]);
    expect(events[0]!.origin).not.toBe(world.floatingOrigin);
    expect(views.map((v) => v.object.position.toArray())).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);
    expect(views.map((v) => worldPosition(world, v))).toEqual(before);

    // A group created later is placed relative to the floating origin too.
    expect(world.regionGroup('cell/0_0').position.toArray()).toEqual([-2 * CELL, 0, -CELL]);

    // A second move shifts every group by the origin delta.
    const groups = ['cell/1_2', 'cell/3_0', 'cell/0_0'].map((id) => world.regionGroup(id));
    const positions = groups.map((g) => g.position.clone());
    world.setFloatingOrigin('cell/3_3');
    const delta = new Vector3(CELL, 0, 2 * CELL);
    expect(groups.map((g) => g.position.toArray())).toEqual(
      positions.map((p) => p.clone().sub(delta).toArray()),
    );
    expectPlaced();
    expect(events.map((e) => e.regionId)).toEqual(['cell/2_1', 'cell/3_3']);
    expect(views.map((v) => worldPosition(world, v))).toEqual(before);
  });

  it('rebases the camera controller by the origin delta and moves a scene-space host camera with the scene', () => {
    const { world, host } = setup();
    const rebases: Vec3[] = [];
    const cam: CameraController = {
      attach: () => {},
      update: () => {},
      detach: () => {},
      rebase: (delta) => rebases.push({ ...delta }),
    };
    world.setCamera(cam);
    host.camera.position.set(100, 50, 25);

    world.setFloatingOrigin('cell/1_0');
    expect(rebases).toEqual([{ x: CELL, y: 0, z: 0 }]);
    expect(host.camera.position.toArray()).toEqual([100 - CELL, 50, 25]);

    world.setFloatingOrigin('cell/0_2');
    expect(rebases).toEqual([
      { x: CELL, y: 0, z: 0 },
      { x: -CELL, y: 0, z: 2 * CELL },
    ]);
    expect(host.camera.position.toArray()).toEqual([100, 50, 25 - 2 * CELL]);

    // A camera inside the moving content (here a region group) keeps its local position.
    const holder = new Group();
    world.regionGroup('cell/0_0').add(holder);
    holder.add(host.camera);
    host.camera.position.set(1, 2, 3);
    world.setCamera({ attach: () => {}, update: () => {}, detach: () => {} }); // no rebase
    world.setFloatingOrigin('cell/1_1');
    expect(host.camera.position.toArray()).toEqual([1, 2, 3]);
    expect(rebases).toHaveLength(2);
  });

  it('an unknown region is a RangeError and changes nothing; after dispose it is a no-op', () => {
    const { world } = setup();
    world.setFloatingOrigin('cell/1_1');
    const group = world.regionGroup('cell/2_2');
    const events: RegionId[] = [];
    world.on('floatingOrigin', ({ regionId }) => events.push(regionId));
    expect(() => world.setFloatingOrigin('cell/4_4')).toThrow(RangeError);
    expect(world.floatingOrigin).toEqual({ x: CELL, y: 0, z: CELL });
    expect(world.floatingRegion).toBe('cell/1_1');
    expect(group.position.toArray()).toEqual([CELL, 0, CELL]);
    expect(events).toEqual([]);

    world.dispose();
    world.setFloatingOrigin('cell/0_0');
    expect(world.floatingRegion).toBe('cell/1_1');
  });

  it('floatingRegion is the fallback region of an entity without one', () => {
    const { fixture, world } = setup();
    world.setFloatingOrigin('cell/2_3');
    fixture.snapshot(3, {
      creates: [{ entity: 7, components: [comp(Transform, Transform.create())] }],
    });
    fixture.setRenderTick(3);
    world.update(DT);
    expect(world.view(7)!.object.parent).toBe(world.regionGroup('cell/2_3'));
    expect(world.regionGroup('cell/2_3').position.toArray()).toEqual([0, 0, 0]);
  });
});

it('prepares one region-local predicted pose for region/model/camera at 144 Hz and resets camera on teleport', () => {
  const { fixture, world } = setup();
  fixture.snapshot(3, {
    creates: [
      { entity: 1, components: [regionOf('cell/1_1'), transformAt({ x: 10, y: 0, z: 20 })] },
    ],
  });
  fixture.setRenderTick(3);
  let samples = 0;
  let resets = 0;
  let boundary = 'before';
  let region = 'cell/1_1';
  let x = 11;
  const cameraPoses: number[] = [];
  world.setPresentationProvider({
    sample: (entity, tick, out) => {
      samples++;
      out.entity = entity;
      out.tick = tick;
      out.regionId = region;
      out.boundaryKey = boundary;
      out.transform.pos.x = x;
      out.transform.pos.y = 0;
      out.transform.pos.z = 20;
      return true;
    },
  });
  world.setCamera({
    attach() {},
    detach() {},
    reset() {
      resets++;
    },
    update: (_, ctx) => {
      expect(ctx.presentation?.regionId).toBe(region);
      expect(ctx.target?.regionId).toBe(region);
      cameraPoses.push(ctx.target!.object.position.x);
      expect(ctx.target!.object.parent).toBe(world.regionGroup(region));
    },
  });
  world.cameraTarget(1);
  for (let frame = 0; frame < 144; frame++) {
    if (frame === 72) {
      boundary = 'teleport';
      region = 'cell/2_1';
      x = 5;
    }
    world.preparePresentation((frame * 1000) / 144);
    world.setFloatingOrigin(region);
    world.update(1 / 144);
    expect(world.view(1)!.object.position.x).toBe(x);
    expect(regionFrameOffset(world.view(1)!)).toEqual({ x: 0, y: 0, z: 0 });
  }
  expect(samples).toBe(144);
  expect(resets).toBe(2);
  expect(cameraPoses.slice(0, 72)).toEqual(Array(72).fill(11));
  expect(cameraPoses.slice(72)).toEqual(Array(72).fill(5));
  expect(fixture.replica.read(1, Transform)?.pos.x).toBe(10);
  world.dispose();
});

import { q, type Vec3 } from '@conduit/math';
import { Group, Vector3, type PerspectiveCamera } from 'three';
import { describe, expect, it } from 'vitest';
import {
  FOLLOW_LOOK_AHEAD_DEFAULT,
  FOLLOW_LOOK_OFFSET_DEFAULT,
  FOLLOW_OFFSET_DEFAULT,
  FOLLOW_STIFFNESS_DEFAULT,
  FollowCamera,
  NULL_INPUT,
  ORBIT_DISTANCE_DEFAULT,
  ORBIT_PITCH_DEFAULT,
  ORBIT_SENSITIVITY,
  ORBIT_SMOOTHING,
  ORBIT_ZOOM_SPEED,
  OrbitCamera,
  TOPDOWN_HEIGHT_DEFAULT,
  TOPDOWN_TILT_DEFAULT,
  TopDownCamera,
  toThreeQuat,
  toThreeVec3,
  TransformBinder,
  type CameraContext,
  type EntityView,
  type InputSource,
} from '../src/index.ts';
import { createWorld, regionOf, transformAt } from './replica-fixture.ts';

const DT = 1 / 60;
const Y_AXIS: Vec3 = { x: 0, y: 1, z: 0 };

function targetView(id: number): EntityView {
  return { id, regionId: 'cell/0_0', object: new Group(), data: {}, attached: new Set() };
}

function followContext(target: EntityView | null, input: InputSource = NULL_INPUT): CameraContext {
  const { world, host } = createWorld();
  return { camera: host.camera, world, input, target, dt: 0 };
}

/** An `InputSource` whose deltas the test sets; reads reset them, as the interface requires. */
class ScriptedInput implements InputSource {
  dx = 0;
  dy = 0;
  wheel = 0;
  readonly down = new Set<number>();
  pointerReads = 0;

  drag(dx: number, dy: number): this {
    this.dx += dx;
    this.dy += dy;
    return this;
  }

  pointerDelta(): { x: number; y: number } {
    this.pointerReads += 1;
    const d = { x: this.dx, y: this.dy };
    this.dx = 0;
    this.dy = 0;
    return d;
  }

  wheelDelta(): number {
    const w = this.wheel;
    this.wheel = 0;
    return w;
  }

  isPointerDown(button: 0 | 1 | 2): boolean {
    return this.down.has(button);
  }

  isKeyDown(): boolean {
    return false;
  }
}

/** Spherical coordinates of the camera around `centre` (yaw about +Y from +Z, pitch from level). */
function sphericalOf(
  camera: PerspectiveCamera,
  centre: Vector3,
): { yaw: number; pitch: number; distance: number } {
  const offset = camera.position.clone().sub(centre);
  const distance = offset.length();
  return { yaw: Math.atan2(offset.x, offset.z), pitch: Math.asin(offset.y / distance), distance };
}

/** Where a default FollowCamera wants to be for `view`: its position plus the rotated offset. */
function desiredFor(view: EntityView): Vector3 {
  return toThreeVec3(FOLLOW_OFFSET_DEFAULT)
    .applyQuaternion(view.object.quaternion)
    .add(view.object.position);
}

function expectVecClose(actual: Vector3, want: Vector3, digits = 9): void {
  expect(actual.x).toBeCloseTo(want.x, digits);
  expect(actual.y).toBeCloseTo(want.y, digits);
  expect(actual.z).toBeCloseTo(want.z, digits);
}

function expectLooksAt(ctx: CameraContext, point: Vector3): void {
  const dir = ctx.camera.getWorldDirection(new Vector3());
  expectVecClose(dir, point.clone().sub(ctx.camera.position).normalize(), 9);
}

describe('FollowCamera', () => {
  it('has the documented defaults', () => {
    expect(FOLLOW_OFFSET_DEFAULT).toEqual({ x: 0, y: 6, z: -14 });
    expect(FOLLOW_STIFFNESS_DEFAULT).toBe(8);
    expect(FOLLOW_LOOK_AHEAD_DEFAULT).toBe(0.3);
    expect(FOLLOW_LOOK_OFFSET_DEFAULT).toEqual({ x: 0, y: 1.5, z: 0 });
  });

  it('attach snaps behind the target (rotated offset) and looks at target + lookOffset', () => {
    const target = targetView(1);
    target.object.position.set(10, 0, 20);
    toThreeQuat(q.fromAxisAngle(Y_AXIS, Math.PI / 2), target.object.quaternion); // forward +Z -> +X
    const ctx = followContext(target);
    new FollowCamera().attach(ctx);
    expectVecClose(ctx.camera.position, new Vector3(-4, 6, 20));
    expect(ctx.camera.up.toArray()).toEqual([0, 1, 0]);
    expectLooksAt(ctx, new Vector3(10, 1.5, 20));
  });

  it('converges to target + rotated offset within 2 s at 60 fps and never overshoots', () => {
    const target = targetView(1);
    const ctx = followContext(target);
    const cam = new FollowCamera();
    cam.attach(ctx);
    const start = ctx.camera.position.clone();

    target.object.position.set(40, 2, -25);
    toThreeQuat(q.fromAxisAngle(Y_AXIS, 2), target.object.quaternion);
    const desired = desiredFor(target);
    const toDesired = desired.clone().sub(start);
    let prev = start.distanceTo(desired);
    expect(prev).toBeGreaterThan(20);

    for (let frame = 0; frame < 120; frame++) {
      ctx.dt = DT;
      cam.update(DT, ctx);
      const d = ctx.camera.position.distanceTo(desired);
      expect(d).toBeLessThanOrEqual(prev); // monotone
      // never past the goal along the approach direction
      expect(desired.clone().sub(ctx.camera.position).dot(toDesired)).toBeGreaterThanOrEqual(0);
      prev = d;
    }
    expect(prev).toBeLessThan(1e-4);
  });

  it('with a still target and NULL_INPUT the camera does not move', () => {
    const target = targetView(1);
    target.object.position.set(-3, 1, 7);
    toThreeQuat(q.fromAxisAngle(Y_AXIS, -0.4), target.object.quaternion);
    const ctx = followContext(target);
    const cam = new FollowCamera();
    cam.attach(ctx);
    const position = ctx.camera.position.clone();
    const quaternion = ctx.camera.quaternion.clone();
    for (let frame = 0; frame < 60; frame++) cam.update(DT, ctx);
    expect(ctx.camera.position.equals(position)).toBe(true);
    expect(ctx.camera.quaternion.equals(quaternion)).toBe(true);
  });

  it('holds still without a target and snaps when a target appears or changes', () => {
    const ctx = followContext(null);
    const cam = new FollowCamera();
    cam.attach(ctx);
    ctx.camera.position.set(1, 2, 3);
    cam.update(DT, ctx);
    expect(ctx.camera.position.toArray()).toEqual([1, 2, 3]);

    const a = targetView(1);
    a.object.position.set(100, 0, 0);
    ctx.target = a;
    cam.update(DT, ctx);
    expectVecClose(ctx.camera.position, desiredFor(a));

    const b = targetView(2);
    b.object.position.set(-50, 0, 30);
    ctx.target = b;
    cam.update(DT, ctx);
    expectVecClose(ctx.camera.position, desiredFor(b));
  });

  it('looks ahead of a moving target by lookAhead seconds of its velocity', () => {
    const target = targetView(1);
    const ctx = followContext(target);
    const cam = new FollowCamera();
    cam.attach(ctx);
    const speed = 5; // m/s along +Z (the target's forward)
    for (let frame = 0; frame < 30; frame++) {
      target.object.position.z += speed * DT;
      cam.update(DT, ctx);
    }
    const look = target.object.position
      .clone()
      .add(toThreeVec3(FOLLOW_LOOK_OFFSET_DEFAULT))
      .add(new Vector3(0, 0, speed * FOLLOW_LOOK_AHEAD_DEFAULT));
    expectLooksAt(ctx, look);
  });

  it('honours custom options', () => {
    const target = targetView(1);
    target.object.position.set(2, 0, 2);
    const ctx = followContext(target);
    new FollowCamera({
      offset: { x: 0, y: 10, z: 0 },
      lookOffset: { x: 0, y: 0, z: 1 },
      up: { x: 0, y: 0, z: 1 },
    }).attach(ctx);
    expectVecClose(ctx.camera.position, new Vector3(2, 10, 2));
    expect(ctx.camera.up.toArray()).toEqual([0, 0, 1]);
    expectLooksAt(ctx, new Vector3(2, 0, 3));

    const stiff = new FollowCamera({ stiffness: 60 });
    stiff.attach(ctx);
    target.object.position.set(12, 0, 2);
    stiff.update(0.5, ctx);
    expect(ctx.camera.position.distanceTo(desiredFor(target))).toBeLessThan(1e-9);
  });

  it('rebase shifts the spring state with the scene so the camera does not jerk', () => {
    const target = targetView(1);
    target.object.position.set(500, 0, 500);
    const ctx = followContext(target);
    const cam = new FollowCamera();
    cam.attach(ctx);
    target.object.position.set(520, 0, 500);
    for (let frame = 0; frame < 5; frame++) cam.update(DT, ctx); // mid-flight
    target.object.position.set(520, 0, 500);
    cam.update(DT, ctx);
    const before = ctx.camera.position.clone();
    const gapBefore = desiredFor(target).sub(before);

    const delta: Vec3 = { x: 512, y: 0, z: 512 };
    target.object.position.sub(toThreeVec3(delta));
    cam.rebase(delta);
    cam.update(DT, ctx);
    const gapAfter = desiredFor(target).sub(ctx.camera.position);
    const k = Math.exp(-FOLLOW_STIFFNESS_DEFAULT * DT);
    expectVecClose(gapAfter, gapBefore.multiplyScalar(k), 6);
  });

  it('RenderWorld drives it on the cameraTarget view, in scene space', () => {
    const { fixture, world, host } = createWorld();
    world.registerBinder(new TransformBinder());
    world.setCamera(new FollowCamera());
    world.cameraTarget(5);
    fixture.snapshot(3, {
      creates: [
        { entity: 5, components: [regionOf('cell/1_1'), transformAt({ x: 3, y: 0, z: 4 })] },
      ],
    });
    fixture.snapshot(6, {
      updates: [{ entity: 5, components: [transformAt({ x: 3, y: 0, z: 34 })] }],
    });
    fixture.setRenderTick(3);
    world.update(DT); // first sight: snap
    expectVecClose(host.camera.position, new Vector3(256 + 3, 6, 256 + 4 - 14));

    fixture.setRenderTick(6);
    let prev = Infinity;
    for (let frame = 0; frame < 120; frame++) {
      world.update(DT);
      const d = host.camera.position.distanceTo(new Vector3(259, 6, 256 + 34 - 14));
      expect(d).toBeLessThanOrEqual(prev);
      prev = d;
    }
    expect(prev).toBeLessThan(1e-4);
  });
});

describe('OrbitCamera', () => {
  it('has the documented defaults', () => {
    expect(ORBIT_DISTANCE_DEFAULT).toBe(12);
    expect(ORBIT_PITCH_DEFAULT).toBe(0.5);
    expect(ORBIT_SENSITIVITY).toBe(0.005);
    expect(ORBIT_ZOOM_SPEED).toBe(0.001);
    expect(ORBIT_SMOOTHING).toBe(12);
  });

  it('attach snaps onto the orbit sphere around the target and looks at it', () => {
    const target = targetView(1);
    target.object.position.set(10, 0, 20);
    toThreeQuat(q.fromAxisAngle(Y_AXIS, 1), target.object.quaternion); // orbit ignores rotation
    const ctx = followContext(target);
    new OrbitCamera().attach(ctx);
    const d = ORBIT_DISTANCE_DEFAULT;
    const p = ORBIT_PITCH_DEFAULT;
    expectVecClose(ctx.camera.position, new Vector3(10, d * Math.sin(p), 20 + d * Math.cos(p)));
    expect(ctx.camera.up.toArray()).toEqual([0, 1, 0]);
    expectLooksAt(ctx, target.object.position);

    const custom = followContext(target);
    new OrbitCamera({ distance: 5, yaw: Math.PI / 2, pitch: 0.25 }).attach(custom);
    const flat = 5 * Math.cos(0.25);
    expectVecClose(custom.camera.position, new Vector3(10 + flat, 5 * Math.sin(0.25), 20));
  });

  it('dragging with the drag button changes yaw by -dx * sensitivity and pitch by +dy, clamped', () => {
    const target = targetView(1);
    target.object.position.set(-4, 2, 9);
    const input = new ScriptedInput();
    const ctx = followContext(target, input);
    const cam = new OrbitCamera({ smoothing: 0, yaw: 0.2, pitch: 0.6 });
    cam.attach(ctx);
    const centre = target.object.position;

    input.down.add(0);
    input.drag(40, -20);
    cam.update(DT, ctx);
    let s = sphericalOf(ctx.camera, centre);
    expect(s.yaw).toBeCloseTo(0.2 - 40 * ORBIT_SENSITIVITY, 9);
    expect(s.pitch).toBeCloseTo(0.6 - 20 * ORBIT_SENSITIVITY, 9);
    expect(s.distance).toBeCloseTo(ORBIT_DISTANCE_DEFAULT, 9);
    expectLooksAt(ctx, centre);

    input.drag(0, 10_000); // far past maxPitch
    cam.update(DT, ctx);
    expect(sphericalOf(ctx.camera, centre).pitch).toBeCloseTo(1.5, 9);
    input.drag(-30, -10_000); // far below minPitch
    cam.update(DT, ctx);
    s = sphericalOf(ctx.camera, centre);
    expect(s.pitch).toBeCloseTo(0.05, 9);
    expect(s.yaw).toBeCloseTo(0.2 - 10 * ORBIT_SENSITIVITY, 9);

    // Without the button the movement is consumed, not applied (and not replayed later).
    const resting = ctx.camera.position.clone();
    input.down.clear();
    input.drag(500, 500);
    cam.update(DT, ctx);
    expect(input.dx).toBe(0);
    input.down.add(0);
    cam.update(DT, ctx);
    expectVecClose(ctx.camera.position, resting, 12);

    // Another button only rotates with dragButton set to it.
    const right = new OrbitCamera({ smoothing: 0, dragButton: 2, pitch: 0.5, minPitch: 0.1 });
    right.attach(ctx);
    input.down.clear();
    input.down.add(0);
    input.drag(100, 0);
    right.update(DT, ctx);
    expect(sphericalOf(ctx.camera, centre).yaw).toBeCloseTo(0, 9);
    input.down.add(2);
    input.drag(100, 0);
    right.update(DT, ctx);
    expect(sphericalOf(ctx.camera, centre).yaw).toBeCloseTo(-100 * ORBIT_SENSITIVITY, 9);
  });

  it('the wheel zooms multiplicatively, clamped to [minDistance, maxDistance]', () => {
    const target = targetView(1);
    const input = new ScriptedInput();
    const ctx = followContext(target, input);
    const cam = new OrbitCamera({ smoothing: 0 });
    cam.attach(ctx);
    const centre = target.object.position;

    input.wheel = 250;
    cam.update(DT, ctx);
    expect(sphericalOf(ctx.camera, centre).distance).toBeCloseTo(12 * 1.25, 9);
    input.wheel = -500;
    cam.update(DT, ctx);
    expect(sphericalOf(ctx.camera, centre).distance).toBeCloseTo(12 * 1.25 * 0.5, 9);
    expect(input.wheel).toBe(0);

    for (let i = 0; i < 20; i++) {
      input.wheel = 5000;
      cam.update(DT, ctx);
    }
    expect(sphericalOf(ctx.camera, centre).distance).toBeCloseTo(200, 9);
    for (let i = 0; i < 20; i++) {
      input.wheel = -900;
      cam.update(DT, ctx);
    }
    expect(sphericalOf(ctx.camera, centre).distance).toBeCloseTo(2, 9);

    const bounded = new OrbitCamera({ smoothing: 0, distance: 1000, maxDistance: 50 });
    bounded.attach(ctx);
    expect(sphericalOf(ctx.camera, centre).distance).toBeCloseTo(50, 9);
    input.wheel = -10;
    bounded.update(DT, ctx);
    expect(sphericalOf(ctx.camera, centre).distance).toBeCloseTo(50 * 0.99, 9);
  });

  it('eases toward a moved target without overshooting, and NULL_INPUT leaves it still', () => {
    const target = targetView(1);
    const ctx = followContext(target);
    const cam = new OrbitCamera();
    cam.attach(ctx);
    const position = ctx.camera.position.clone();
    const quaternion = ctx.camera.quaternion.clone();
    for (let frame = 0; frame < 60; frame++) cam.update(DT, ctx);
    expect(ctx.camera.position.equals(position)).toBe(true);
    expect(ctx.camera.quaternion.equals(quaternion)).toBe(true);

    target.object.position.set(30, 0, -10);
    const desired = position.clone().add(target.object.position);
    const k = 1 - Math.exp(-ORBIT_SMOOTHING * DT);
    cam.update(DT, ctx);
    expectVecClose(ctx.camera.position, position.clone().lerp(desired, k), 9);
    expectLooksAt(ctx, target.object.position); // the look point is not eased
    let prev = ctx.camera.position.distanceTo(desired);
    for (let frame = 0; frame < 120; frame++) {
      cam.update(DT, ctx);
      const d = ctx.camera.position.distanceTo(desired);
      expect(d).toBeLessThanOrEqual(prev);
      prev = d;
    }
    expect(prev).toBeLessThan(1e-4);
  });

  it('orbits point without a target; rebase moves point and the eased position with the scene', () => {
    const ctx = followContext(null);
    const cam = new OrbitCamera({ point: { x: 100, y: 5, z: 100 }, pitch: 0.05, yaw: 0 });
    cam.attach(ctx);
    const point = new Vector3(100, 5, 100);
    expect(sphericalOf(ctx.camera, point).distance).toBeCloseTo(12, 9);
    expectLooksAt(ctx, point);

    const delta: Vec3 = { x: 64, y: 0, z: -32 };
    cam.rebase(delta);
    cam.update(DT, ctx);
    const shifted = point.clone().sub(toThreeVec3(delta));
    expect(sphericalOf(ctx.camera, shifted).distance).toBeCloseTo(12, 9);
    expectLooksAt(ctx, shifted);
  });

  it('snaps instead of easing when the target appears, changes or goes away (like FollowCamera)', () => {
    const ctx = followContext(null);
    const cam = new OrbitCamera({ point: { x: 1, y: 0, z: 1 } });
    cam.attach(ctx); // orbiting point
    const a = targetView(1);
    a.object.position.set(2000, 0, 2000);
    ctx.target = a;
    cam.update(DT, ctx);
    expect(sphericalOf(ctx.camera, a.object.position).distance).toBeCloseTo(12, 9);
    const b = targetView(2);
    b.object.position.set(-300, 5, 40);
    ctx.target = b;
    cam.update(DT, ctx);
    expect(sphericalOf(ctx.camera, b.object.position).distance).toBeCloseTo(12, 9);
    ctx.target = null;
    cam.update(DT, ctx);
    expect(sphericalOf(ctx.camera, new Vector3(1, 0, 1)).distance).toBeCloseTo(12, 9);

    const top = followContext(null);
    const down = new TopDownCamera({ smoothing: 12 });
    down.attach(top);
    top.target = a;
    down.update(DT, top);
    expect(top.camera.position.distanceTo(a.object.position)).toBeCloseTo(60, 9);
  });

  it('RenderWorld drives it with the world input on the cameraTarget view', () => {
    const { fixture, world, host } = createWorld();
    const input = new ScriptedInput();
    world.registerBinder(new TransformBinder());
    world.setInput(input);
    world.cameraTarget(5);
    world.setCamera(new OrbitCamera({ smoothing: 0 }));
    fixture.snapshot(3, {
      creates: [
        { entity: 5, components: [regionOf('cell/1_0'), transformAt({ x: 3, y: 0, z: 4 })] },
      ],
    });
    fixture.setRenderTick(3);
    input.down.add(0);
    input.drag(-100, 0);
    world.update(DT);
    const s = sphericalOf(host.camera, new Vector3(256 + 3, 0, 4));
    expect(s.yaw).toBeCloseTo(100 * ORBIT_SENSITIVITY, 9);
    expect(s.distance).toBeCloseTo(12, 9);
  });
});

describe('TopDownCamera', () => {
  it('has the documented defaults and snaps on attach to height along the tilted axis', () => {
    expect(TOPDOWN_HEIGHT_DEFAULT).toBe(60);
    expect(TOPDOWN_TILT_DEFAULT).toBe(0.9);
    const target = targetView(1);
    target.object.position.set(7, 1, -3);
    const ctx = followContext(target);
    new TopDownCamera().attach(ctx);
    const flat = 60 * Math.sin(0.9);
    expectVecClose(ctx.camera.position, new Vector3(7, 1 + 60 * Math.cos(0.9), -3 + flat));
    expectLooksAt(ctx, target.object.position);

    const yawed = followContext(target);
    new TopDownCamera({ yaw: -Math.PI / 2, height: 20, tilt: 0.5 }).attach(yawed);
    expectVecClose(
      yawed.camera.position,
      new Vector3(7 - 20 * Math.sin(0.5), 1 + 20 * Math.cos(0.5), -3),
    );
  });

  it('height follows the wheel multiplicatively and is clamped to [minHeight, maxHeight]', () => {
    const target = targetView(1);
    const input = new ScriptedInput();
    const ctx = followContext(target, input);
    const cam = new TopDownCamera({ smoothing: 0, tilt: 0.3 });
    cam.attach(ctx);
    const centre = target.object.position;

    input.wheel = 500;
    cam.update(DT, ctx);
    expect(ctx.camera.position.distanceTo(centre)).toBeCloseTo(90, 9);
    for (let i = 0; i < 20; i++) {
      input.wheel = 4000;
      cam.update(DT, ctx);
    }
    expect(ctx.camera.position.distanceTo(centre)).toBeCloseTo(500, 9);
    for (let i = 0; i < 20; i++) {
      input.wheel = -900;
      cam.update(DT, ctx);
    }
    expect(ctx.camera.position.distanceTo(centre)).toBeCloseTo(10, 9);
    expect(sphericalOf(ctx.camera, centre).pitch).toBeCloseTo(Math.PI / 2 - 0.3, 9);

    const bounded = new TopDownCamera({ smoothing: 0, height: 5, minHeight: 25, maxHeight: 30 });
    bounded.attach(ctx);
    expect(ctx.camera.position.distanceTo(centre)).toBeCloseTo(25, 9);
    input.wheel = 1000;
    bounded.update(DT, ctx);
    expect(ctx.camera.position.distanceTo(centre)).toBeCloseTo(30, 9);
  });

  it('with NULL_INPUT and a still target it does not move; a pointer drag does nothing', () => {
    const target = targetView(1);
    target.object.position.set(1, 2, 3);
    const input = new ScriptedInput();
    const ctx = followContext(target, input);
    const cam = new TopDownCamera();
    cam.attach(ctx);
    const position = ctx.camera.position.clone();
    const quaternion = ctx.camera.quaternion.clone();
    for (let frame = 0; frame < 60; frame++) cam.update(DT, ctx);
    input.down.add(0);
    input.drag(300, 300);
    cam.update(DT, ctx);
    expect(ctx.camera.position.equals(position)).toBe(true);
    expect(ctx.camera.quaternion.equals(quaternion)).toBe(true);

    const still = followContext(target);
    const other = new TopDownCamera({ height: 33 });
    other.attach(still);
    const p = still.camera.position.clone();
    for (let frame = 0; frame < 60; frame++) other.update(DT, still);
    expect(still.camera.position.equals(p)).toBe(true);
  });

  it('looks straight down at tilt 0 with screen up toward yaw; centres on the origin without a target', () => {
    const ctx = followContext(null);
    new TopDownCamera({ tilt: 0, height: 40, yaw: Math.PI / 2 }).attach(ctx);
    expectVecClose(ctx.camera.position, new Vector3(0, 40, 0));
    expectVecClose(ctx.camera.getWorldDirection(new Vector3()), new Vector3(0, -1, 0));
    // The camera's local +Y (screen up) points along -(sin yaw, 0, cos yaw) = -X.
    const screenUp = new Vector3(0, 1, 0).applyQuaternion(ctx.camera.quaternion);
    expectVecClose(screenUp, new Vector3(-1, 0, 0));
  });

  it('eases toward a moved target; rebase keeps the gap so the camera does not jerk', () => {
    const target = targetView(1);
    const ctx = followContext(target);
    const cam = new TopDownCamera();
    cam.attach(ctx);
    const start = ctx.camera.position.clone();
    target.object.position.set(0, 0, 50);
    const desired = start.clone().add(target.object.position);
    const k = 1 - Math.exp(-12 * DT);
    cam.update(DT, ctx);
    expectVecClose(ctx.camera.position, start.clone().lerp(desired, k), 9);
    const gapBefore = desired.clone().sub(ctx.camera.position);

    const delta: Vec3 = { x: 256, y: 0, z: 256 };
    target.object.position.sub(toThreeVec3(delta));
    cam.rebase(delta);
    cam.update(DT, ctx);
    const gapAfter = desired.clone().sub(toThreeVec3(delta)).sub(ctx.camera.position);
    expectVecClose(gapAfter, gapBefore.multiplyScalar(1 - k), 6);
  });
});

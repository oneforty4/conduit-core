// The sandbox systems (PLAN.md "Sandbox content spec"), in registration order. Pure (docs/sim.md
// 2.12): no wall clock, no Math.random, all state in components, randomness from ctx.regionRng.
import { defineSystem, Owner, Region, Transform } from '@conduit/game';
import { q, type Quat, type Rng, type Vec3, wrapAngle } from '@conduit/math';
import { Vehicle, Wanderer } from './components.ts';
import {
  INPUT_MAX,
  MAX_SPEED,
  PLACE_MAX,
  PLACE_MIN,
  TURN_RATE,
  WANDERER_ARRIVE_RADIUS,
} from './constants.ts';
import { Horn } from './events.ts';
import { BUTTON_HORN, type SandboxInput } from './input.ts';

const UP: Readonly<Vec3> = Object.freeze({ x: 0, y: 1, z: 0 });

/** A raw i8 input clamped to `-INPUT_MAX..INPUT_MAX` (the wire also allows -128). */
export function clampAxis(value: number): number {
  return value > INPUT_MAX ? INPUT_MAX : value < -INPUT_MAX ? -INPUT_MAX : value;
}

/** Heading of a yaw-only rotation: the angle about +Y that turns +Z into the facing direction. */
export function yawOf(rot: Readonly<Quat>): number {
  return wrapAngle(2 * Math.atan2(rot.y, rot.w));
}

/**
 * A region-local ground point with x and z in `[PLACE_MIN, PLACE_MAX)`, drawn from `rng` in that
 * order (x, then z), written into `out`.
 */
export function randomGroundPoint(rng: Rng, out: Vec3): Vec3 {
  out.x = PLACE_MIN + rng.float() * (PLACE_MAX - PLACE_MIN);
  out.y = 0;
  out.z = PLACE_MIN + rng.float() * (PLACE_MAX - PLACE_MIN);
  return out;
}

/**
 * Phase `input`: copies each owner's `throttle`, `steer` and `buttons` into its `Vehicle` (all 0
 * without input). When `BUTTON_HORN` is set now but was not in the stored `buttons` (a rising edge;
 * a held button, or a frame the server holds over, sounds once) it emits `Horn { entity }` in the
 * vehicle's region. A vehicle whose input did not change is not written.
 */
export const vehicleInput = defineSystem('vehicleInput', 'input', (ctx) => {
  const { world } = ctx;
  for (const e of world.query(Owner, Vehicle)) {
    const frame = ctx.inputs(world.get(e, Owner).player) as Readonly<SandboxInput> | undefined;
    const throttle = frame === undefined ? 0 : clampAxis(frame.throttle);
    const steer = frame === undefined ? 0 : clampAxis(frame.steer);
    const buttons = frame === undefined ? 0 : frame.buttons >>> 0;
    const current = world.get(e, Vehicle);
    if (current.throttle === throttle && current.steer === steer && current.buttons === buttons) {
      continue;
    }
    if ((buttons & BUTTON_HORN) !== 0 && (current.buttons & BUTTON_HORN) === 0) {
      ctx.events.emit(Horn, { entity: e }, world.tryGet(e, Region)?.id);
    }
    const vehicle = world.write(e, Vehicle);
    vehicle.throttle = throttle;
    vehicle.steer = steer;
    vehicle.buttons = buttons;
  }
});

/**
 * Phase `sim`: kinematic driving. Steering turns the heading at up to `TURN_RATE`; the vehicle moves
 * along its heading (+Z rotated by the yaw) at `throttle / 127 * MAX_SPEED`. Positive steer turns
 * right: a driver facing +Z has -X on the right, so the yaw decreases. A vehicle without input is
 * not written.
 */
export const vehicleKinematics = defineSystem('vehicleKinematics', 'sim', (ctx) => {
  const { world, dt } = ctx;
  for (const e of world.query(Vehicle, Transform)) {
    const { throttle, steer } = world.get(e, Vehicle);
    if (throttle === 0 && steer === 0) {
      const vel = world.get(e, Transform).vel;
      if (vel.x !== 0 || vel.y !== 0 || vel.z !== 0) {
        const t = world.write(e, Transform);
        t.vel.x = 0;
        t.vel.y = 0;
        t.vel.z = 0;
      }
      continue;
    }
    const t = world.write(e, Transform);
    const yaw = wrapAngle(yawOf(t.rot) - (steer / INPUT_MAX) * TURN_RATE * dt);
    const speed = (throttle / INPUT_MAX) * MAX_SPEED;
    q.fromAxisAngle(UP, yaw, t.rot);
    t.vel.x = Math.sin(yaw) * speed;
    t.vel.y = 0;
    t.vel.z = Math.cos(yaw) * speed;
    t.pos.x += t.vel.x * dt;
    t.pos.z += t.vel.z * dt;
  }
});

/**
 * Phase `sim`: each wanderer walks straight at `speed` towards its region-local `target`, facing
 * where it goes; within `WANDERER_ARRIVE_RADIUS` of the target it first picks a new one from its
 * region's stream (`randomGroundPoint`).
 */
export const wandererAi = defineSystem('wandererAi', 'sim', (ctx) => {
  const { world, dt } = ctx;
  for (const e of world.query(Wanderer, Transform, Region)) {
    const wanderer = world.get(e, Wanderer);
    const pos = world.get(e, Transform).pos;
    let dx = wanderer.target.x - pos.x;
    let dz = wanderer.target.z - pos.z;
    let dist = Math.sqrt(dx * dx + dz * dz);
    if (dist <= WANDERER_ARRIVE_RADIUS) {
      const target = world.write(e, Wanderer).target;
      randomGroundPoint(ctx.regionRng(world.get(e, Region).id), target);
      dx = target.x - pos.x;
      dz = target.z - pos.z;
      dist = Math.sqrt(dx * dx + dz * dz);
    }
    if (dist === 0 || wanderer.speed <= 0) continue;
    const nx = dx / dist;
    const nz = dz / dist;
    const step = Math.min(wanderer.speed * dt, dist);
    const t = world.write(e, Transform);
    t.pos.x += nx * step;
    t.pos.z += nz * step;
    t.vel.x = nx * wanderer.speed;
    t.vel.y = 0;
    t.vel.z = nz * wanderer.speed;
    q.fromAxisAngle(UP, Math.atan2(nx, nz), t.rot);
  }
});

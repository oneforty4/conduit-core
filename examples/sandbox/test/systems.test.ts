import { Region, Transform } from '@conduit/game';
import { Rng, wrapAngle } from '@conduit/math';
import { slotOf } from '@conduit/sim';
import { describe, expect, it } from 'vitest';
import { Vehicle, Wanderer } from '../src/shared/components.ts';
import {
  INPUT_MAX,
  MAX_SPEED,
  PLACE_MAX,
  PLACE_MIN,
  SPAWN_REGION,
  TURN_RATE,
  WANDERER_SPEED,
  WANDERER_START,
} from '../src/shared/constants.ts';
import { Horn } from '../src/shared/events.ts';
import { game } from '../src/shared/game.ts';
import { BUTTON_BRAKE, BUTTON_HORN } from '../src/shared/input.ts';
import { clampAxis, randomGroundPoint, yawOf } from '../src/shared/systems.ts';
import { input, SandboxSim } from './harness.ts';

const TICKS_PER_SECOND = game.tickRate;

async function spawned(playerId = 0): Promise<{ s: SandboxSim; e: number }> {
  const s = new SandboxSim();
  await s.activateSpawn();
  return { s, e: s.spawn(playerId) };
}

function run(s: SandboxSim, ticks: number, frames: Parameters<SandboxSim['step']>[0] = []): void {
  for (let i = 0; i < ticks; i++) s.step(frames);
}

function wanderersIn(s: SandboxSim, regionId: string): number[] {
  return [...s.world.query(Wanderer, Region)].filter((e) => s.world.get(e, Region).id === regionId);
}

describe('vehicleInput', () => {
  it("copies the owner's throttle and steer into Vehicle, clamped to -127..127", async () => {
    const { s, e } = await spawned(1);
    s.step([undefined, input(127, -40)]);
    expect(s.world.get(e, Vehicle)).toMatchObject({ throttle: 127, steer: -40 });
    s.step([undefined, input(-128, -128)]);
    expect(s.world.get(e, Vehicle)).toMatchObject({ throttle: -INPUT_MAX, steer: -INPUT_MAX });
    s.step([input(127, 127)]); // player 0's frame does not drive player 1's vehicle
    expect(s.world.get(e, Vehicle)).toMatchObject({ throttle: 0, steer: 0 });
    expect(clampAxis(200)).toBe(INPUT_MAX);
  });

  it('writes nothing for a vehicle whose input did not change', async () => {
    const { s, e } = await spawned(0);
    run(s, 2, [input(0)]);
    const vehicleVersion = s.world.store(Vehicle).version[slotOf(e)];
    const transformVersion = s.world.store(Transform).version[slotOf(e)];
    run(s, 30, [input(0)]);
    expect(s.world.store(Vehicle).version[slotOf(e)]).toBe(vehicleVersion);
    expect(s.world.store(Transform).version[slotOf(e)]).toBe(transformVersion);
    run(s, 30, [input(0, 0, BUTTON_HORN)]);
    const held = s.world.store(Vehicle).version[slotOf(e)];
    expect(held).toBeGreaterThan(vehicleVersion as number); // the press itself is written once
    run(s, 10, [input(0, 0, BUTTON_HORN)]);
    expect(s.world.store(Vehicle).version[slotOf(e)]).toBe(held);
  });

  it("emits Horn { entity } in the vehicle's region on each BUTTON_HORN rising edge only", async () => {
    const { s, e } = await spawned(2);
    s.spawn(5);
    // Every Horn emitted in a step, as the Session's outbox drain sees it after the step.
    const horns = (frames: Parameters<SandboxSim['step']>[0]) => {
      s.step(frames);
      return s.sim.events.drainOutbox().filter((ev) => ev.typeId === game.registry.eventId(Horn));
    };
    const player2 = (buttons: number) => [undefined, undefined, input(0, 0, buttons)];

    expect(horns(player2(0))).toEqual([]);
    const pressed = horns(player2(BUTTON_HORN));
    expect(pressed).toEqual([
      {
        typeId: game.registry.eventId(Horn),
        tick: s.world.tick,
        regionId: SPAWN_REGION,
        payload: { entity: e },
      },
    ]);
    expect(s.world.get(e, Vehicle).buttons).toBe(BUTTON_HORN);
    // Held (and held with another button added): no new edge.
    for (let i = 0; i < 20; i++) expect(horns(player2(BUTTON_HORN))).toEqual([]);
    expect(horns(player2(BUTTON_HORN | BUTTON_BRAKE))).toEqual([]);
    // Released, then pressed again: a second Horn. A missing frame counts as released.
    expect(horns(player2(0))).toEqual([]);
    expect(horns(player2(BUTTON_HORN))).toHaveLength(1);
    expect(horns([])).toEqual([]);
    expect(s.world.get(e, Vehicle).buttons).toBe(0);
    expect(horns(player2(BUTTON_HORN | BUTTON_BRAKE))).toHaveLength(1);
    // Other buttons alone never sound it; player 5's vehicle is unaffected by player 2's horn.
    expect(horns([...player2(0), undefined, undefined, input(0, 0, BUTTON_BRAKE)])).toEqual([]);
    expect(Horn.replicate).toBe(true);
  });
});

describe('vehicleKinematics', () => {
  it('drives along +Z at MAX_SPEED on full throttle, backwards on -127, and stops without input', async () => {
    const { s, e } = await spawned(3);
    expect(s.world.get(e, Transform).pos).toEqual({ x: 6, y: 0, z: 0 });
    const drive = (frame: ReturnType<typeof input>) => [undefined, undefined, undefined, frame];
    run(s, TICKS_PER_SECOND, drive(input(127)));
    const t = s.world.get(e, Transform);
    expect(t.pos.x).toBe(6);
    expect(t.pos.z).toBeCloseTo(MAX_SPEED, 9);
    expect(t.vel).toEqual({ x: 0, y: 0, z: MAX_SPEED });
    expect(yawOf(t.rot)).toBe(0);
    run(s, TICKS_PER_SECOND / 2, drive(input(-127)));
    expect(t.pos.z).toBeCloseTo(MAX_SPEED / 2, 9);
    expect(t.vel.z).toBe(-MAX_SPEED);
    run(s, 1, drive(input(0)));
    expect(t.vel).toEqual({ x: 0, y: 0, z: 0 });
    const stopped = { ...t.pos };
    const version = s.world.store(Transform).version[slotOf(e)];
    run(s, 10, drive(input(0)));
    expect(t.pos).toEqual(stopped);
    expect(s.world.store(Transform).version[slotOf(e)]).toBe(version);
  });

  it('turns right (towards -X) on positive steer at TURN_RATE, and left on negative steer', async () => {
    // Player 7 spawns at x = 14: a one-second full turn (radius 13.3 m) stays inside the cell.
    const frames = (frame: ReturnType<typeof input>) => [...Array<undefined>(7), frame];
    const right = await spawned(7);
    run(right.s, TICKS_PER_SECOND, frames(input(127, 127)));
    const r = right.s.world.get(right.e, Transform);
    expect(right.s.world.get(right.e, Region).id).toBe(SPAWN_REGION);
    expect(yawOf(r.rot)).toBeCloseTo(-TURN_RATE, 9);
    expect(r.pos.x).toBeLessThan(14);
    expect(r.pos.z).toBeGreaterThan(0);
    expect(r.vel.x).toBeCloseTo(Math.sin(-TURN_RATE) * MAX_SPEED, 9);
    expect(r.vel.z).toBeCloseTo(Math.cos(-TURN_RATE) * MAX_SPEED, 9);

    const left = await spawned(7);
    run(left.s, TICKS_PER_SECOND, frames(input(127, -127)));
    const l = left.s.world.get(left.e, Transform);
    expect(yawOf(l.rot)).toBeCloseTo(TURN_RATE, 9);
    expect(l.pos.x - 14).toBeCloseTo(14 - r.pos.x, 9);
    expect(l.pos.z).toBeCloseTo(r.pos.z, 9);
    // rot is the yaw quaternion about +Y
    expect(l.rot.x).toBeCloseTo(0, 12);
    expect(l.rot.z).toBeCloseTo(0, 12);
    expect(l.rot.y).toBeCloseTo(Math.sin(TURN_RATE / 2), 9);
  });

  it('turns in place without throttle', async () => {
    const { s, e } = await spawned(0);
    run(s, TICKS_PER_SECOND * 3, [input(0, 127)]);
    const t = s.world.get(e, Transform);
    expect(t.pos).toEqual({ x: 0, y: 0, z: 0 });
    expect(Math.hypot(t.vel.x, t.vel.y, t.vel.z)).toBe(0);
    expect(yawOf(t.rot)).toBeCloseTo(wrapAngle(-3 * TURN_RATE), 9);
  });
});

describe('wandererAi', () => {
  it('walks towards its target at its speed, facing where it goes', async () => {
    const { s } = await spawned(0);
    const [w] = wanderersIn(s, SPAWN_REGION);
    if (w === undefined) throw new Error('no wanderer');
    const target = { ...s.world.get(w, Wanderer).target };
    const start = { ...s.world.get(w, Transform).pos };
    expect(start).toEqual({ x: WANDERER_START, y: 0, z: WANDERER_START });
    run(s, TICKS_PER_SECOND);
    const t = s.world.get(w, Transform);
    const dx = target.x - start.x;
    const dz = target.z - start.z;
    const dist = Math.hypot(dx, dz);
    expect(dist).toBeGreaterThan(WANDERER_SPEED); // true for this seed: still under way after 1 s
    expect(t.pos.x).toBeCloseTo(start.x + (dx / dist) * WANDERER_SPEED, 6);
    expect(t.pos.z).toBeCloseTo(start.z + (dz / dist) * WANDERER_SPEED, 6);
    expect(Math.hypot(t.vel.x, t.vel.z)).toBeCloseTo(WANDERER_SPEED, 9);
    expect(yawOf(t.rot)).toBeCloseTo(Math.atan2(dx, dz), 9);
    expect(s.world.get(w, Wanderer).target).toEqual(target);
  });

  it("picks each new target from its region's stream once within 1 m, inside [8, 248)", async () => {
    const { s } = await spawned(0);
    const [w] = wanderersIn(s, SPAWN_REGION);
    if (w === undefined) throw new Error('no wanderer');
    // The loader drew 8 crates and the first target; replay that stream to predict the next targets.
    const def = s.graph.get(SPAWN_REGION);
    if (def === undefined) throw new Error('no spawn region');
    const expected = new Rng(def.seed);
    for (let i = 0; i < 9; i++) randomGroundPoint(expected, { x: 0, y: 0, z: 0 });
    const targets: { x: number; z: number }[] = [];
    let last = { ...s.world.get(w, Wanderer).target };
    for (let tick = 0; tick < 240 * TICKS_PER_SECOND && targets.length < 3; tick++) {
      s.step();
      const now = s.world.get(w, Wanderer).target;
      if (now.x !== last.x || now.z !== last.z) {
        const pos = s.world.get(w, Transform).pos;
        expect(Math.hypot(pos.x - last.x, pos.z - last.z)).toBeLessThanOrEqual(1 + 4 / 60);
        targets.push({ x: now.x, z: now.z });
        last = { ...now };
      }
    }
    expect(targets).toHaveLength(3);
    for (const target of targets) {
      const next = randomGroundPoint(expected, { x: 0, y: 0, z: 0 });
      expect(target).toEqual({ x: next.x, z: next.z });
      for (const v of [target.x, target.z]) {
        expect(v).toBeGreaterThanOrEqual(PLACE_MIN);
        expect(v).toBeLessThan(PLACE_MAX);
      }
    }
  });
});

describe('determinism', () => {
  it('the same seed and input log give the same world hash on every tick', async () => {
    const script = (tick: number) => [
      input(tick % 200 < 120 ? 127 : -60, tick % 90 < 30 ? 127 : 0),
      input(tick % 150 < 100 ? 100 : 0, tick % 70 < 20 ? -127 : 0),
    ];
    const hashes = async (): Promise<number[]> => {
      const { s } = await spawned(0);
      s.spawn(1);
      const out: number[] = [];
      for (let tick = 0; tick < 600; tick++) {
        s.step(script(tick));
        out.push(s.world.hash());
      }
      return out;
    };
    const first = await hashes();
    expect(await hashes()).toEqual(first);
    expect(new Set(first).size).toBeGreaterThan(500); // the world really changed tick to tick
  });
});

import { Rng, v3, type Vec3 } from '@conduit/math';
import { ByteReader, ByteWriter, decodeWith, encodeWith } from '@conduit/protocol';
import { Owner, Region, Transform, defineSystem, type EntityId } from '@conduit/sim';
import { describe, expect, it } from 'vitest';
import {
  InterestPolicy,
  NodeWorld,
  WorldGraphError,
  contains,
  fromJson,
  type RegionDef,
  type RegionId,
  type WorldGraphJson,
} from '../src/index.ts';
import { place, rig } from './rig.ts';

// docs/world.md §10 `test/nodeWorld.test.ts`, and the Spike 4 decision of docs/world.md §3.

function system(id: RegionId, neighbors: RegionId[], extra: Partial<RegionDef> = {}): RegionDef {
  return {
    id,
    kind: 'system',
    bounds: { kind: 'node', origin: { x: 0, y: 0, z: 0 } },
    neighbors,
    assets: [],
    seed: 1000 + id.length,
    ...extra,
  };
}

/**
 * sol - alpha - centauri - deneb
 *  |
 * barnard           epsilon (no gates)
 * Neighbour lists are given out of order on purpose.
 */
function starMap(opts?: ConstructorParameters<typeof NodeWorld>[1]): NodeWorld {
  return new NodeWorld(
    [
      system('sol', ['barnard', 'alpha']),
      system('deneb', ['centauri']),
      system('alpha', ['sol', 'centauri']),
      system('barnard', ['sol']),
      system('centauri', ['deneb', 'alpha']),
      system('epsilon', []),
    ],
    opts,
  );
}

const anywhere: Vec3 = { x: 12, y: -3, z: 4e5 };

describe('NodeWorld', () => {
  it('locate returns the hint when it names a region, else null', () => {
    const g = starMap();
    expect(g.locate(anywhere, 'alpha')).toBe('alpha');
    expect(g.locate({ x: Number.NaN, y: 0, z: 0 }, 'deneb')).toBe('deneb');
    expect(g.locate(anywhere)).toBeNull();
    expect(g.locate(anywhere, 'nowhere')).toBeNull();
  });

  it('wanted is breadth-first: self, then each hop ascending by id, each region once, to depth', () => {
    const g = starMap();
    expect(g.wantedDepth).toBe(1);
    expect(g.wanted('sol')).toEqual(['sol', 'alpha', 'barnard']);
    expect(g.wanted('sol', 0)).toEqual(['sol']);
    expect(g.wanted('sol', 2)).toEqual(['sol', 'alpha', 'barnard', 'centauri']);
    expect(g.wanted('sol', 3)).toEqual(['sol', 'alpha', 'barnard', 'centauri', 'deneb']);
    expect(g.wanted('sol', 50)).toEqual(g.wanted('sol', 3));
    expect(g.wanted('centauri')).toEqual(['centauri', 'alpha', 'deneb']);
    expect(g.wanted('deneb', 2)).toEqual(['deneb', 'centauri', 'alpha']);
    expect(g.wanted('epsilon', 4)).toEqual(['epsilon']);
    expect(g.wanted('nowhere')).toEqual([]);
    for (const depth of [-1, 1.5, Number.NaN]) {
      expect(() => g.wanted('sol', depth)).toThrow(RangeError);
    }
    expect(g.neighbors('sol')).toEqual(['alpha', 'barnard']);
    expect(g.neighbors('nowhere')).toEqual([]);
    // InterestPolicy's prefetch ring for a NodeWorld is the second hop.
    const interest = new InterestPolicy({
      graph: g,
      regions: { regionOf: () => undefined, entitiesIn: () => [] },
    });
    expect(interest.prefetchForRegion('sol')).toEqual(['centauri']);
  });

  it('a wanted override replaces the search, deduplicated, with the region itself forced first', () => {
    const calls: [RegionId, number][] = [];
    const g = starMap({
      wanted: (id, graph, depth) => {
        calls.push([id, depth]);
        expect(graph.get(id)).toBeDefined();
        // Only the current system is active; deeper requests (prefetch) add every gate target.
        return depth <= 1 ? ['deneb', id, 'deneb'] : [...graph.neighbors(id), id, 'epsilon'];
      },
    });
    expect(g.wanted('sol')).toEqual(['sol', 'deneb']);
    expect(g.wanted('sol', 2)).toEqual(['sol', 'alpha', 'barnard', 'epsilon']);
    expect(g.wanted('nowhere')).toEqual([]);
    expect(calls).toEqual([
      ['sol', 1],
      ['sol', 2],
    ]);
  });

  it('throws WorldGraphError for a missing neighbour, a duplicate id, bounds that are not node, or a bad neighbour list', () => {
    expect(() => new NodeWorld([system('sol', ['vega'])])).toThrow(WorldGraphError);
    expect(() => new NodeWorld([system('sol', ['vega'])])).toThrow(/unknown neighbour 'vega'/);
    expect(() => new NodeWorld([system('sol', []), system('sol', [])])).toThrow(/duplicate/);
    const bounded = system('sol', [], {
      bounds: { kind: 'aabb3', origin: v3.create(), min: v3.create(), max: v3.create(1, 1, 1) },
    });
    expect(() => new NodeWorld([bounded])).toThrow(WorldGraphError);
    expect(() => new NodeWorld([system('sol', ['sol'])])).toThrow(/itself/);
    expect(() => new NodeWorld([system('sol', ['a', 'a']), system('a', [])])).toThrow(/twice/);
    expect(() => new NodeWorld([])).not.toThrow();
  });

  it('copies its defs: callers keep their arrays, get returns sorted neighbours', () => {
    const defs = [system('b', ['c', 'a']), system('a', []), system('c', [])];
    const g = new NodeWorld(defs);
    expect(defs[0]?.neighbors).toEqual(['c', 'a']);
    expect(g.get('b')?.neighbors).toEqual(['a', 'c']);
    (defs[0] as RegionDef).bounds.origin.x = 99;
    expect(g.get('b')?.bounds.origin.x).toBe(0);
    expect(g.get('nowhere')).toBeUndefined();
  });

  it('toJson / fromJson round-trip, directly and through the graph fromJson', () => {
    const g = new NodeWorld([
      system('sol', ['alpha'], { assets: ['star-yellow'], data: { faction: 'union', tl: 3 } }),
      system('alpha', ['sol'], { bounds: { kind: 'node', origin: { x: 4e9, y: -2, z: 7 } } }),
      system('odd', [], { data: { big: 10n } }), // not JSON: omitted
    ]);
    const json = g.toJson();
    expect(json.kind).toBe('node');
    expect(json.grid).toBeUndefined();
    expect(json.regions.map((d) => d.id)).toEqual(['alpha', 'odd', 'sol']);
    expect(json.regions[2]?.data).toEqual({ faction: 'union', tl: 3 });
    expect(json.regions[1] && 'data' in json.regions[1]).toBe(false);
    const reparsed = JSON.parse(JSON.stringify(json)) as WorldGraphJson;
    for (const copy of [NodeWorld.fromJson(reparsed), fromJson(reparsed)]) {
      expect(copy).toBeInstanceOf(NodeWorld);
      expect(copy.toJson()).toEqual(json);
      expect(copy.wanted('sol', 2)).toEqual(g.wanted('sol', 2));
      expect(copy.get('alpha')?.bounds.origin).toEqual({ x: 4e9, y: -2, z: 7 });
    }
    expect(() =>
      NodeWorld.fromJson({ ...reparsed, version: 2 } as unknown as WorldGraphJson),
    ).toThrow(WorldGraphError);
    expect(() => NodeWorld.fromJson({ ...reparsed, kind: 'grid' })).toThrow(WorldGraphError);
    const broken = JSON.parse(JSON.stringify(json)) as WorldGraphJson;
    broken.regions[0]?.neighbors.push('vega');
    expect(() => fromJson(broken)).toThrow(WorldGraphError);
  });
});

// ---------------------------------------------------------------------------------------------
// Spike 4 (docs/world.md §3): a Spacehunter star system is one node region with the core
// Transform, whose `pos` is fixed32(0.001) and `vel` f32 on the wire (docs/sim.md 2.5).

/** fixed32(0.001): the largest and smallest positions per axis. */
const POS_MAX = 2_147_483_647 * 0.001;
const POS_MIN = -2_147_483_648 * 0.001;
/**
 * The speed per axis the range was sized against: a third over the reference game's 250 m/s
 * cruise. (It was the cap of `vel` while that was fixed16(0.01); as f32 it has none.)
 */
const FAST = 32_767 * 0.01;
/** The Escape-Velocity-style reference system of docs/world.md §3, in metres. */
const PLANET_ORBITS = [6_000, 15_000, 32_000, 50_000];
const JUMP_RADIUS = 100_000;
/** Where the reference game turns ships back or forces a jump (docs/world.md §3). */
const SYSTEM_EDGE = 1_000_000;
/** Half a quantization step, plus the float error of `i32 * 0.001` at 2e6 m. */
const TOLERANCE = 0.0005 + 1e-9;

type TransformValue = ReturnType<typeof Transform.create>;

function replicate(value: TransformValue): TransformValue {
  const w = new ByteWriter(64);
  encodeWith(w, Transform.schema, value);
  return decodeWith(new ByteReader(w.view()), Transform.schema);
}

function transformAt(pos: Vec3, vel: Vec3 = v3.create()): TransformValue {
  const t = Transform.create();
  v3.copy(pos, t.pos);
  v3.copy(vel, t.vel);
  return t;
}

function expectWithin(actual: Vec3, expected: Vec3, tolerance: number, what: string): void {
  for (const axis of ['x', 'y', 'z'] as const) {
    expect(Math.abs(actual[axis] - expected[axis]), `${what} ${axis}`).toBeLessThanOrEqual(
      tolerance,
    );
  }
}

describe('Spike 4: a star system fits the core Transform', () => {
  it('replicates every position out to the system edge within half a millimetre', () => {
    const rng = new Rng(4);
    const points: [string, Vec3][] = [];
    for (const orbit of [...PLANET_ORBITS, JUMP_RADIUS]) {
      for (let k = 0; k < 16; k++) {
        const angle = (k / 16) * 2 * Math.PI + rng.float() * 0.1;
        points.push([
          `r=${orbit} #${k}`,
          { x: orbit * Math.cos(angle), y: rng.float() * 50, z: orbit * Math.sin(angle) },
        ]);
      }
    }
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const edge = SYSTEM_EDGE - 0.0004;
          points.push([`edge ${sx}${sy}${sz}`, { x: sx * edge, y: sy * edge, z: sz * edge }]);
        }
      }
    }
    for (let i = 0; i < 2000; i++) {
      const span = SYSTEM_EDGE * 2;
      points.push([
        `random ${i}`,
        {
          x: (rng.float() - 0.5) * span,
          y: (rng.float() - 0.5) * span,
          z: (rng.float() - 0.5) * span,
        },
      ]);
    }
    for (const [what, pos] of points) {
      expectWithin(replicate(transformAt(pos)).pos, pos, TOLERANCE, what);
    }
  });

  it('a ship a third over cruise on every axis stays inside the codec range for over 1.8 hours of straight flight', () => {
    expect(POS_MAX / FAST).toBeGreaterThan(1.8 * 3600);
    expect(POS_MAX / JUMP_RADIUS).toBeGreaterThan(21);
    // One hour at 60 Hz, flying diagonally at that speed on every axis, from the star.
    const vel = { x: FAST, y: -FAST, z: FAST };
    const pos = v3.create();
    for (let tick = 0; tick < 60 * 3600; tick++) v3.add(pos, v3.scale(vel, 1 / 60), pos);
    expect(pos.x).toBeGreaterThan(1_179_000);
    expect(pos.x).toBeLessThan(POS_MAX);
    const replicated = replicate(transformAt(pos, vel));
    expectWithin(replicated.pos, pos, TOLERANCE, 'after an hour');
    expectWithin(replicated.vel, vel, 1e-4, 'velocity');
  });

  it('replicates a velocity whatever it is: f32 has no cap a game will meet', () => {
    // A supersonic aircraft, a missile, a ship at a hundred kilometres a second, one at rest.
    for (const vel of [
      { x: 380, y: -12.5, z: 0.25 },
      { x: -1_650, y: 900, z: 1_200.4 },
      { x: 100_000, y: -100_000, z: 100_000.7 },
      { x: 0, y: 0, z: 0 },
    ]) {
      const replicated = replicate(transformAt(v3.create(), vel)).vel;
      // (Seven significant digits: an f32's.)
      for (const axis of ['x', 'y', 'z'] as const) {
        const off = Math.abs(replicated[axis] - vel[axis]);
        expect(off, `${axis} of ${JSON.stringify(vel)}`).toBeLessThanOrEqual(
          Math.abs(vel[axis]) * 1e-7,
        );
      }
    }
  });

  it('beyond ±2 147 km the codec saturates, which is why a space game keeps its own system edge', () => {
    const far = replicate(transformAt({ x: 2_200_000, y: -2_200_000, z: POS_MAX })).pos;
    expect(far.x).toBe(POS_MAX);
    expect(far.y).toBe(POS_MIN);
    expectWithin(far, { x: POS_MAX, y: POS_MIN, z: POS_MAX }, TOLERANCE, 'limit');
  });

  it('a ship crosses its whole system inside one node region; jumping to the next is an explicit migrate', async () => {
    const graph = new NodeWorld([
      system('sol', ['alpha'], { bounds: { kind: 'node', origin: { x: 0, y: 0, z: 0 } } }),
      system('alpha', ['sol'], { bounds: { kind: 'node', origin: { x: 4.1e16, y: 0, z: 0 } } }),
    ]);
    // Flight: 1 000 m/s per tick outwards along x, y and z; enough to leave any bounded region.
    const cruise = defineSystem('cruise', 'sim', (ctx) => {
      for (const e of ctx.world.query(Owner, Transform)) {
        const t = ctx.world.write(e, Transform);
        v3.add(t.pos, { x: 1000, y: -1000, z: 1000 }, t.pos);
      }
    });
    const h = rig({ graph, systems: [cruise] });
    const ship = place(
      h.world,
      'sol',
      v3.create(SYSTEM_EDGE - 5_000, -(SYSTEM_EDGE - 5_000), JUMP_RADIUS),
    );
    h.world.add(ship, Owner, { player: 0 });
    for (let i = 0; i < 4; i++) await h.tick([ship]);
    expect(h.regions.active()).toEqual(['alpha', 'sol']); // the gate target is wanted, so active

    const sol = graph.get('sol') as RegionDef;
    for (let i = 0; i < 6; i++) {
      await h.tick([ship]);
      const pos = h.world.get(ship, Transform).pos;
      expect(h.regions.regionOf(ship)).toBe('sol');
      expect(contains(sol, pos)).toBe(true);
      expectWithin(replicate(transformAt(pos)).pos, pos, TOLERANCE, `tick ${h.world.tick}`);
    }
    expect(h.world.get(ship, Transform).pos.x).toBeGreaterThan(SYSTEM_EDGE); // past the game's edge
    expect(h.changes).toEqual([]);
    expect(h.edges).toEqual([]); // node regions never clamp

    // The jump: arrive at alpha's jump radius, facing in.
    expect(h.regions.migrate(ship, 'alpha', v3.create(-JUMP_RADIUS, 0, 0))).toBe('moved');
    expect(h.world.get(ship, Region).id).toBe('alpha');
    expect(h.world.get(ship, Transform).pos).toEqual({ x: -JUMP_RADIUS, y: 0, z: 0 });
    const jumpedAt = h.world.tick; // between steps: the bus stamps world.tick
    await h.tick([ship]);
    expect(h.changes).toEqual([
      { tick: jumpedAt, entity: ship as EntityId, from: 'sol', to: 'alpha' },
    ]);
    expect(h.regions.entitiesIn('alpha')).toEqual([ship]);
    expect(h.regions.entitiesIn('sol')).toEqual([]);
  });
});

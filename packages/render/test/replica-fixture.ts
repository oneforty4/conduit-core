import type { AssetLoader } from '@conduit/assets';
import type { Quat, Vec3 } from '@conduit/math';
import { NetClock, ReplicaWorld } from '@conduit/net-client';
import {
  defineInput,
  f,
  REGION_IDX_NONE,
  SchemaRegistry,
  SNAPSHOT_FLAG_FULL,
  type SnapshotComponent,
  type SnapshotData,
} from '@conduit/protocol';
import {
  CORE_COMPONENTS,
  Region,
  Transform,
  type ComponentType,
  type EntityId,
} from '@conduit/sim';
import { GridWorld, type RegionId } from '@conduit/world';
import { RenderHost, RenderWorld, type RenderHostOptions } from '../src/index.ts';
import { FakeRenderer, FrameDriver } from './fake-renderer.ts';

/** 50 Hz makes `tickMs` 20 ms, so tick <-> ms conversions in `NetClock` are exact. */
export const FIXTURE_TICK_RATE = 50;
export const FIXTURE_SNAPSHOT_EVERY = 3;
/** The fixture graph is a 4 x 4 `GridWorld` of these cells: `cell/ix_iy` at `(ix, 0, iy) * 256`. */
export const FIXTURE_CELL_SIZE = 256;

export interface ComponentValue {
  readonly component: ComponentType<unknown>;
  readonly value: unknown;
}

export function comp<T>(component: ComponentType<T>, value: T): ComponentValue {
  return { component: component as ComponentType<unknown>, value };
}

export function transformAt(
  pos: Vec3,
  rot: Quat = { x: 0, y: 0, z: 0, w: 1 },
  vel: Vec3 = { x: 0, y: 0, z: 0 },
): ComponentValue {
  return comp(Transform, { pos, rot, vel });
}

export function regionOf(id: RegionId): ComponentValue {
  return comp(Region, { id });
}

export interface CreateSpec {
  entity: EntityId;
  components: readonly ComponentValue[];
  /** Region table entry of the create; default: the `Region` component's id, else none. */
  region?: RegionId | null;
}

export interface UpdateSpec {
  entity: EntityId;
  components?: readonly ComponentValue[];
  removed?: readonly ComponentType<unknown>[];
}

export interface SnapshotSpec {
  creates?: readonly CreateSpec[];
  updates?: readonly UpdateSpec[];
  destroys?: readonly EntityId[];
  full?: boolean;
}

/**
 * A real `ReplicaWorld` + `NetClock` (docs/render.md §9) over the core components plus `components`,
 * fed with synthetic snapshots, and a `GridWorld` graph for region groups.
 */
export class ReplicaFixture {
  readonly registry: SchemaRegistry;
  readonly replica: ReplicaWorld;
  readonly clock: NetClock;
  readonly graph: GridWorld;
  /** `ReplicaWorld` log lines (`level: msg`). */
  readonly logs: string[] = [];
  private lastTick = 0;

  constructor(opts: { components?: readonly ComponentType<unknown>[] } = {}) {
    const components: ComponentType<unknown>[] = [...CORE_COMPONENTS, ...(opts.components ?? [])];
    this.registry = new SchemaRegistry({
      components,
      messages: [],
      events: [],
      input: defineInput({ tick: f.u32 }),
    });
    this.replica = new ReplicaWorld(this.registry, components, {
      tickRate: FIXTURE_TICK_RATE,
      snapshotEvery: FIXTURE_SNAPSHOT_EVERY,
      log: (level, msg) => this.logs.push(`${level}: ${msg}`),
    });
    this.clock = new NetClock({ now: () => 0 });
    this.clock.configure(FIXTURE_TICK_RATE, FIXTURE_SNAPSHOT_EVERY);
    this.graph = new GridWorld({ cellSize: FIXTURE_CELL_SIZE, cols: 4, rows: 4, worldSeed: 1 });
  }

  /**
   * Applies a snapshot for server tick `tick` whose baseline is the previous one (0 when `full`).
   * Component values are copied, so every snapshot holds fresh objects as `decodeSnapshot` yields.
   */
  snapshot(tick: number, spec: SnapshotSpec = {}): SnapshotData {
    const regions: RegionId[] = [];
    const indexOf = (region: RegionId | null): number => {
      if (region === null) return REGION_IDX_NONE;
      const i = regions.indexOf(region);
      return i >= 0 ? i : regions.push(region) - 1;
    };
    const full = spec.full === true;
    const data: SnapshotData = {
      header: {
        serverTick: tick,
        serverTimeMs: tick * this.clock.tickMs,
        baselineTick: full ? 0 : this.lastTick,
        lastInputSeq: 0,
        lastInputTick: 0,
        flags: full ? SNAPSHOT_FLAG_FULL : 0,
      },
      regions,
      creates: (spec.creates ?? []).map((c) => ({
        entity: c.entity,
        regionIdx: indexOf(c.region !== undefined ? c.region : regionIn(c.components)),
        components: this.encode(c.components),
      })),
      updates: (spec.updates ?? []).map((u) => ({
        entity: u.entity,
        components: this.encode(u.components ?? []),
        removed: (u.removed ?? []).map((c) => this.registry.componentId(c)).sort((a, b) => a - b),
      })),
      destroys: [...(spec.destroys ?? [])],
    };
    this.replica.applySnapshot(data);
    this.lastTick = tick;
    return data;
  }

  /**
   * Drives the real clock so that `clock.renderTick() === tick` exactly: a single offset-0 sample
   * with tick 0 at server time 0, then one `update` at `tick × tickMs + interpolation delay`.
   */
  setRenderTick(tick: number): void {
    const clock = this.clock;
    clock.reset();
    clock.addSample(0, 0, 0);
    clock.update(tick * clock.tickMs + (clock.interpDelayTicks * 1000) / clock.tickRate);
    if (clock.renderTick() !== tick) {
      throw new Error(`ReplicaFixture: renderTick is ${clock.renderTick()}, wanted ${tick}`);
    }
  }

  private encode(values: readonly ComponentValue[]): SnapshotComponent[] {
    return values
      .map(({ component, value }) => ({
        id: this.registry.componentId(component),
        value: component.schema.copy(value, component.schema.create()),
      }))
      .sort((a, b) => a.id - b.id);
  }
}

function regionIn(values: readonly ComponentValue[]): RegionId | null {
  const region = values.find((v) => v.component === Region);
  return region === undefined ? null : (region.value as { id: RegionId }).id;
}

export interface WorldSetup {
  fixture: ReplicaFixture;
  frames: FrameDriver;
  renderer: FakeRenderer;
  host: RenderHost;
  world: RenderWorld;
}

/**
 * A `RenderHost` on a `FakeRenderer` and `FrameDriver`, and a `RenderWorld` over `fixture` (with
 * `assets` as its loader, none by default).
 */
export function createWorld(
  fixture: ReplicaFixture = new ReplicaFixture(),
  hostOpts: Partial<RenderHostOptions> = {},
  assets?: AssetLoader,
): WorldSetup {
  const frames = new FrameDriver();
  const renderer = new FakeRenderer();
  const host = new RenderHost({
    canvas: renderer.domElement,
    renderer,
    raf: frames.raf,
    caf: frames.caf,
    now: frames.now,
    ...hostOpts,
  });
  const world = new RenderWorld(host, fixture.replica, fixture.clock, assets, fixture.graph);
  return { fixture, frames, renderer, host, world };
}

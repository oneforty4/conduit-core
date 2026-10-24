import { describe, expect, it } from 'vitest';
import { REGION_IDX_NONE } from '@conduit/protocol';
import {
  PredictionDriver,
  ReplicaWorld,
  SpeculativeEffects,
  type PredictionAdapter,
  type ReconcileView,
} from '../src/index.ts';
import { TestInput, TEST_COMPONENTS, testRegistry } from './helpers.ts';

type Frame = ReturnType<typeof TestInput.create>;
interface State {
  position: number;
  timer: number;
}
interface Command {
  amount: number;
}
function fixture(capacity = 16, throwOutcome = false) {
  const registry = testRegistry();
  const replica = new ReplicaWorld(registry, TEST_COMPONENTS, { tickRate: 60, snapshotEvery: 3 });
  replica.applySnapshot({
    header: {
      serverTick: 0,
      serverTimeMs: 0,
      baselineTick: 0,
      lastInputTick: 0,
      lastInputSeq: 0,
      flags: 0,
    },
    regions: [],
    creates: [{ entity: 1, regionIdx: REGION_IDX_NONE, components: [] }],
    updates: [],
    destroys: [],
  });
  let state: State = { position: 0, timer: 0 };
  let coherent = true;
  let authoritativeTick = 0;
  let boundary = 'spawn';
  let held: Frame | undefined;
  let outcomes: { id: string; outcome: 'confirmed' | 'cancelled' }[] = [];
  let allocations = 0;
  const phases: string[] = [];
  const notified: string[] = [];
  const adapter: PredictionAdapter<State, Frame, State, Command> = {
    createState: () => {
      allocations++;
      return { position: 0, timer: 0 };
    },
    copyState: (source, out) => {
      out.position = source.position;
      out.timer = source.timer;
    },
    readAuthoritative: (_, out) => {
      Object.assign(out, state);
      return {
        coherent,
        authoritativeTick,
        boundaryKey: boundary,
        regionId: 'region-a',
        heldInput: held,
        commandOutcomes: outcomes,
      };
    },
    step: (out, ctx) => {
      phases.push(ctx.phase);
      out.position += (ctx.input?.throttle ?? 0) * ctx.dt;
      out.timer++;
      for (const command of ctx.commands) out.position += command.amount;
    },
    equals: (a, b) => Math.abs(a.position - b.position) < 1e-4 && a.timer === b.timer,
    sample: (a, b, alpha, out) => {
      out.position = a.position + (b.position - a.position) * alpha;
      out.timer = b.timer;
    },
  };
  const driver = new PredictionDriver({
    adapter,
    inputSchema: TestInput,
    tickRate: 60,
    capacity,
    copyCommand: (c) => ({ ...c }),
    onCommandOutcome: (id, outcome) => {
      notified.push(`${id}:${outcome}`);
      if (throwOutcome) throw Error('consumer callback');
    },
  });
  const view = (globalTick = authoritativeTick): ReconcileView => ({
    serverTick: globalTick,
    ackedTick: 0,
    ackedSeq: 0,
    entity: 1,
    authoritative: replica.get(1),
    replica,
    pending: {
      length: 0,
      at() {
        throw Error('empty');
      },
    },
  });
  return {
    driver,
    view,
    adapter,
    replica,
    phases,
    notified,
    get allocations() {
      return allocations;
    },
    reconcile: (tick = authoritativeTick) => driver.reconcile(view(tick)),
    setAuthority: (
      tick: number,
      next: State,
      options: {
        coherent?: boolean;
        boundary?: string;
        held?: Frame;
        outcomes?: typeof outcomes;
      } = {},
    ) => {
      authoritativeTick = tick;
      state = next;
      coherent = options.coherent ?? true;
      boundary = options.boundary ?? boundary;
      held = options.held;
      outcomes = options.outcomes ?? [];
    },
  };
}
const input = (tick: number, throttle = 60): Frame => ({ tick, throttle, buttons: 0 });

describe('PredictionDriver', () => {
  it('replays every fixed tick with held controls, separating authoritative tick from acknowledgements', () => {
    const f = fixture();
    f.reconcile();
    f.driver.recordInput(input(1));
    f.driver.recordInput(input(4));
    expect(f.driver.sample(4, { position: 0, timer: 0 })).toEqual({ position: 4, timer: 4 });
    f.setAuthority(2, { position: 2, timer: 2 }, { held: input(1) });
    f.reconcile(20);
    expect(f.driver.tick).toBe(4);
    expect(f.driver.stats().authoritativeTick).toBe(2);
    expect(f.driver.sample(4, { position: 0, timer: 0 })).toEqual({ position: 4, timer: 4 });
    expect(f.driver.stats().corrections).toBe(0);
    expect(f.phases).toEqual(['predict', 'predict', 'predict', 'predict', 'replay', 'replay']);
  });
  it('retains histories on incoherent snapshots and corrects from the declared group tick', () => {
    const f = fixture();
    f.reconcile();
    f.driver.recordInput(input(1));
    f.driver.recordInput(input(5));
    f.setAuthority(3, { position: 2.5, timer: 3 }, { coherent: false, held: input(1) });
    f.reconcile(100);
    expect(f.driver.stats().retainedInputs).toBe(2);
    expect(f.driver.stats().authoritativeTick).toBe(0);
    f.setAuthority(3, { position: 2.5, timer: 3 }, { held: input(1) });
    f.reconcile(100);
    expect(f.driver.sample(5, { position: 0, timer: 0 })?.position).toBe(4.5);
    expect(f.driver.stats().corrections).toBe(1);
  });
  it('sampling at arbitrary render rates never steps timers or mutates retained state', () => {
    const f = fixture();
    f.reconcile();
    f.driver.recordInput(input(1));
    f.driver.recordInput(input(5));
    for (let frame = 0; frame < 1440; frame++) f.driver.sample(4.5, { position: 0, timer: 0 });
    expect(f.phases).toHaveLength(5);
    expect(f.driver.sample(5, { position: 0, timer: 0 })?.timer).toBe(5);
    f.adapter.sample = (a) => {
      Reflect.set(a, 'timer', 100);
    };
    expect(() => f.driver.sample(4.5, { position: 0, timer: 0 })).toThrow('immutable');
    f.adapter.sample = (_, b, __, out) => {
      out.position = b.position;
      out.timer = b.timer;
    };
    expect(f.driver.ready).toBe(false);
    f.setAuthority(5, { position: 5, timer: 5 }, { held: input(5) });
    f.reconcile();
    expect(f.driver.sample(5, { position: 0, timer: 0 })?.timer).toBe(5);
  });
  it('bounds history allocations and resets on overflow, jumps, replacement and boundary change', () => {
    const f = fixture(4);
    f.reconcile();
    for (let tick = 1; tick <= 30; tick++) {
      f.driver.recordInput(input(tick));
      f.setAuthority(tick, { position: tick, timer: tick }, { held: input(tick) });
      f.reconcile();
    }
    expect(f.allocations).toBeLessThanOrEqual(10);
    expect(f.driver.stats().retainedStates).toBeLessThanOrEqual(4);
    f.driver.recordInput(input(100));
    expect(f.driver.ready).toBe(false);
    f.setAuthority(100, { position: 100, timer: 100 });
    f.reconcile();
    f.setAuthority(101, { position: 0, timer: 101 }, { boundary: 'teleport' });
    f.reconcile();
    expect(f.driver.metadata.boundaryKey).toBe('teleport');
    expect(f.driver.sample(101, { position: 0, timer: 0 })?.position).toBe(0);
    expect(f.driver.stats().resets).toBeGreaterThanOrEqual(2);
  });
  it('replays command events independently of held input, confirms/cancels once, and safely resets late commands', () => {
    const f = fixture();
    f.reconcile();
    expect(f.driver.recordCommand('add-1', 2, { amount: 7 })).toBe(true);
    f.driver.recordInput(input(3, 0));
    expect(f.driver.sample(3, { position: 0, timer: 0 })?.position).toBe(7);
    f.setAuthority(1, { position: 0, timer: 1 }, { held: input(1, 0) });
    f.reconcile();
    expect(f.driver.sample(3, { position: 0, timer: 0 })?.position).toBe(7);
    f.setAuthority(
      2,
      { position: 7, timer: 2 },
      { held: input(2, 0), outcomes: [{ id: 'add-1', outcome: 'confirmed' }] },
    );
    f.reconcile();
    f.reconcile();
    expect(f.notified).toEqual(['add-1:confirmed']);
    expect(f.driver.recordCommand('add-1', 4, { amount: 7 })).toBe(false);
    expect(f.driver.recordCommand('late', 3, { amount: 2 })).toBe(true);
    expect(f.driver.ready).toBe(false);
    f.driver.reset();
    f.driver.reset();
    expect(f.notified).toEqual(['add-1:confirmed', 'late:cancelled']);
  });
});

it('contains effect callback errors, retains tombstones, and cancels pending effects once per epoch', () => {
  const calls: string[] = [];
  const effects = new SpeculativeEffects(
    {
      begin: (id: string) => {
        calls.push(`begin:${id}`);
        throw Error('effect');
      },
      confirm: (id: string) => calls.push(`confirm:${id}`),
      cancel: (id: string) => {
        calls.push(`cancel:${id}`);
        throw Error('cancel');
      },
    },
    2,
  );
  expect(effects.begin('a', {})).toBe(true);
  expect(effects.begin('a', {})).toBe(false);
  effects.confirm('a');
  effects.confirm('a');
  effects.begin('b', {});
  expect(effects.begin('c', {})).toBe(false);
  effects.reset();
  effects.reset();
  expect(effects.size).toBe(0);
  expect(calls).toEqual(['begin:a', 'confirm:a', 'begin:b', 'cancel:b']);
});

it('recovers effect-ledger pressure only at an explicit monotonic epoch boundary', () => {
  let began = 0;
  const effects = new SpeculativeEffects(
    {
      begin: () => {
        began++;
      },
      confirm() {},
      cancel() {},
    },
    1,
  );
  effects.begin('id', {});
  effects.confirm('id');
  expect(effects.begin('new', {})).toBe(false);
  expect(effects.stats()).toMatchObject({ rejected: 1, pressure: true });
  effects.advanceEpoch(10);
  expect(effects.begin('id', {})).toBe(true);
  expect(began).toBe(2);
  expect(() => effects.advanceEpoch(10)).toThrow('monotonically');
});

it('resets bounded input history while incoherent and contains command cleanup callback failures', () => {
  const f = fixture(3, true);
  f.reconcile();
  f.driver.recordCommand('pending', 3, { amount: 1 });
  for (let tick = 1; tick <= 4; tick++) f.driver.recordInput(input(tick));
  expect(f.driver.ready).toBe(false);
  expect(f.driver.stats().retainedInputs).toBeLessThanOrEqual(3);
  expect(f.notified).toEqual(['pending:cancelled']);
  f.driver.reset();
  expect(f.driver.stats().pendingCommands).toBe(0);
});

it('resets on entity generation replacement before adopting the new authoritative state', () => {
  const f = fixture();
  f.reconcile();
  f.driver.recordInput(input(1));
  f.replica.applySnapshot({
    header: {
      serverTick: 1,
      serverTimeMs: 16,
      baselineTick: 0,
      lastInputTick: 0,
      lastInputSeq: 0,
      flags: 0,
    },
    regions: [],
    creates: [{ entity: 2, regionIdx: REGION_IDX_NONE, components: [] }],
    updates: [],
    destroys: [1],
  });
  const view = f.view(1);
  f.driver.reconcile({ ...view, entity: 2, authoritative: f.replica.get(2) });
  expect(f.driver.metadata.entity).toBe(2);
  expect(f.driver.stats().resets).toBe(1);
});

it('retires resolved command history at a declared boundary without resetting movement', () => {
  const f = fixture(2);
  f.reconcile();
  for (let tick = 1; tick <= 2; tick++) {
    f.driver.recordCommand(`command-${tick}`, tick, { amount: 1 });
    f.driver.recordInput(input(tick, 0));
    f.setAuthority(
      tick,
      { position: tick, timer: tick },
      { held: input(tick, 0), outcomes: [{ id: `command-${tick}`, outcome: 'confirmed' }] },
    );
    f.reconcile();
  }
  expect(f.driver.recordCommand('command-3', 3, { amount: 1 })).toBe(false);
  expect(f.driver.stats()).toMatchObject({ commandPressure: true, rejectedCommands: 1 });
  f.driver.retireCommandHistory(2);
  expect(f.driver.ready).toBe(true);
  expect(f.driver.tick).toBe(2);
  expect(f.driver.recordCommand('command-3', 3, { amount: 1 })).toBe(true);
  expect(() => f.driver.retireCommandHistory(1)).toThrow('retirement');
});

it('resets readiness after read/copy/equality/sample adapter exceptions', () => {
  for (const hook of ['readAuthoritative', 'copyState', 'equals', 'sample'] as const) {
    const f = fixture();
    f.reconcile();
    f.driver.recordInput(input(1));
    f.adapter[hook] = () => {
      throw Error('adapter');
    };
    expect(() =>
      hook === 'sample' ? f.driver.sample(1, { position: 0, timer: 0 }) : f.reconcile(1),
    ).toThrow('adapter');
    expect(f.driver.ready).toBe(false);
  }
});

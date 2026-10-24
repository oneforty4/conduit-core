import { q, type Quat } from '@conduit/math';
import { f } from '@conduit/protocol';
import {
  defineComponent,
  Model,
  Region,
  Transform,
  type ComponentType,
  type EntityId,
} from '@conduit/sim';
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, type Object3D } from 'three';
import { describe, expect, it, vi } from 'vitest';
import {
  defaultPlaceholder,
  ModelBinder,
  RegionBinder,
  TransformBinder,
  type Binder,
  type EntityView,
} from '../src/index.ts';
import { comp, createWorld, regionOf, ReplicaFixture, transformAt } from './replica-fixture.ts';

const DT = 1 / 60;
const Health = defineComponent('Health', { hp: f.u16 });

type Event = 'attach' | 'update' | 'detach';

interface Call {
  binder: string;
  event: Event;
  entity: EntityId;
  interpolated?: boolean;
  value?: unknown;
}

function recorder<T>(name: string, component: ComponentType<T>, calls: Call[]): Binder<T> {
  return {
    component,
    onAttach(view, value) {
      calls.push({ binder: name, event: 'attach', entity: view.id, value });
    },
    onUpdate(view, value, interpolated) {
      calls.push({ binder: name, event: 'update', entity: view.id, interpolated, value });
    },
    onDetach(view) {
      calls.push({ binder: name, event: 'detach', entity: view.id });
    },
  };
}

function brief(calls: readonly Call[]): string[] {
  return calls.map(
    (c) =>
      `${c.binder} ${c.event} ${c.entity}` +
      (c.interpolated === undefined ? '' : ` ${c.interpolated ? 'sampled' : 'latest'}`),
  );
}

function setup(): ReturnType<typeof createWorld> {
  return createWorld(new ReplicaFixture({ components: [Health] }));
}

function placeholderOf(view: EntityView | undefined): Object3D | undefined {
  const found = view?.object.children.filter((c) => c.name === 'placeholder') ?? [];
  expect(found.length).toBeLessThanOrEqual(1);
  return found[0];
}

describe('binder lifecycle', () => {
  it('runs binders in registration order, per view in ascending entity id', () => {
    const { fixture, world } = setup();
    const calls: Call[] = [];
    world.registerBinder(recorder('health', Health, calls));
    world.registerBinder(recorder('transform', Transform, calls));
    fixture.snapshot(3, {
      creates: [9, 4].map((entity) => ({
        entity,
        components: [
          regionOf('cell/0_0'),
          transformAt({ x: entity, y: 0, z: 0 }),
          comp(Health, { hp: entity }),
        ],
      })),
    });
    fixture.setRenderTick(3);
    world.update(DT);
    expect(brief(calls)).toEqual([
      'health attach 4',
      'health update 4 latest',
      'transform attach 4',
      'transform update 4 sampled',
      'health attach 9',
      'health update 9 latest',
      'transform attach 9',
      'transform update 9 sampled',
    ]);
  });

  it('onAttach once, then onUpdate every frame: sampled for Transform, latest otherwise', () => {
    const { fixture, world } = setup();
    const calls: Call[] = [];
    world.registerBinder(recorder('health', Health, calls));
    world.registerBinder(recorder('transform', Transform, calls));
    fixture.snapshot(3, {
      creates: [
        {
          entity: 1,
          components: [
            regionOf('cell/0_0'),
            transformAt({ x: 0, y: 0, z: 0 }),
            comp(Health, { hp: 50 }),
          ],
        },
      ],
    });
    fixture.snapshot(6, {
      updates: [
        { entity: 1, components: [transformAt({ x: 6, y: 0, z: 0 }), comp(Health, { hp: 40 })] },
      ],
    });
    for (const tick of [3, 4, 5]) {
      fixture.setRenderTick(tick);
      world.update(DT);
    }
    expect(brief(calls)).toEqual([
      'health attach 1',
      'health update 1 latest',
      'transform attach 1',
      'transform update 1 sampled',
      'health update 1 latest',
      'transform update 1 sampled',
      'health update 1 latest',
      'transform update 1 sampled',
    ]);

    // Non-interpolated binders get the replicated value as of the render tick itself -- before the
    // update at 6, the one from 3, not the newest; interpolated ones a sample.
    const atThree = fixture.replica.readAt(1, Health, 3);
    const healthUpdates = calls.filter((c) => c.binder === 'health' && c.event === 'update');
    expect(healthUpdates.every((c) => c.value === atThree)).toBe(true);
    expect(atThree).toEqual({ hp: 50 });
    expect(fixture.replica.read(1, Health)).toEqual({ hp: 40 });
    const attach = calls.find((c) => c.binder === 'transform' && c.event === 'attach');
    expect(attach?.value).toBe(fixture.replica.readAt(1, Transform, 3)); // as of the render tick
    const sampledXs = calls
      .filter((c) => c.binder === 'transform' && c.event === 'update')
      .map((c) => c.value);
    expect(sampledXs.every((v) => v !== fixture.replica.read(1, Transform))).toBe(true);
  });

  it('removing a component calls onDetach once and keeps the view; re-adding attaches again', () => {
    const { fixture, world } = setup();
    const calls: Call[] = [];
    world.registerBinder(recorder('health', Health, calls));
    world.registerBinder(recorder('region', Region, calls));
    fixture.snapshot(3, {
      creates: [{ entity: 1, components: [regionOf('cell/0_0'), comp(Health, { hp: 1 })] }],
    });
    fixture.setRenderTick(3);
    world.update(DT);
    const view = world.view(1);

    // Removed at 6: still there while the render tick is before it, as the view shows it.
    fixture.snapshot(6, { updates: [{ entity: 1, removed: [Health] }] });
    world.update(DT);
    expect(view?.attached.size).toBe(2);
    fixture.setRenderTick(6);
    world.update(DT);
    expect(world.view(1)).toBe(view);
    expect(view?.attached.size).toBe(1);

    // Back at 9: from the render tick 9 on.
    fixture.snapshot(9, { updates: [{ entity: 1, components: [comp(Health, { hp: 2 })] }] });
    world.update(DT);
    expect(view?.attached.size).toBe(1);
    fixture.setRenderTick(9);
    world.update(DT);
    expect(brief(calls)).toEqual([
      'health attach 1',
      'health update 1 latest',
      'region attach 1',
      'region update 1 latest',
      'health update 1 latest',
      'region update 1 latest',
      'health detach 1',
      'region update 1 latest',
      'region update 1 latest',
      'health attach 1',
      'health update 1 latest',
      'region update 1 latest',
    ]);
    expect(
      calls.filter((c) => c.binder === 'health' && c.event === 'update').map((c) => c.value),
    ).toEqual([{ hp: 1 }, { hp: 1 }, { hp: 2 }]);
  });

  it('gives a component its value as of the render tick, and a newest binder its value as it comes', () => {
    const { fixture, world } = setup();
    const calls: Call[] = [];
    const newest: Call[] = [];
    world.registerBinder(recorder('health', Health, calls));
    world.registerBinder({ ...recorder('health', Health, newest), newest: true });
    fixture.snapshot(3, {
      creates: [{ entity: 1, components: [regionOf('cell/0_0'), comp(Health, { hp: 1 })] }],
    });
    fixture.setRenderTick(3);
    world.update(DT);
    fixture.snapshot(6, { updates: [{ entity: 1, components: [comp(Health, { hp: 2 })] }] });
    world.update(DT);
    fixture.setRenderTick(6);
    world.update(DT);
    const values = (list: Call[]) =>
      list.filter((c) => c.event === 'update').map((c) => (c.value as { hp: number }).hp);
    expect(values(calls)).toEqual([1, 1, 2]);
    expect(values(newest)).toEqual([1, 2, 2]);
  });

  it('destroying a view calls onDetach in reverse registration order, only for attached binders', () => {
    const { fixture, world } = setup();
    const calls: Call[] = [];
    world.registerBinder(recorder('a', Region, calls));
    world.registerBinder(recorder('b', Health, calls)); // never attached: no Health
    world.registerBinder(recorder('c', Transform, calls));
    world.registerBinder(recorder('d', Region, calls));
    fixture.snapshot(3, {
      creates: [
        { entity: 5, components: [regionOf('cell/0_0'), transformAt({ x: 0, y: 0, z: 0 })] },
      ],
    });
    fixture.snapshot(6, { destroys: [5] });
    fixture.setRenderTick(3);
    world.update(DT);
    calls.length = 0;
    const view = world.view(5)!;
    fixture.setRenderTick(6);
    world.update(DT);
    expect(brief(calls)).toEqual(['d detach 5', 'c detach 5', 'a detach 5']);
    expect(view.attached.size).toBe(0);
    expect(world.view(5)).toBeUndefined();
  });

  it('unregistering detaches the binder from every view; registering twice throws', () => {
    const { fixture, world } = setup();
    const calls: Call[] = [];
    const binder = recorder('health', Health, calls);
    const off = world.registerBinder(binder);
    expect(() => world.registerBinder(binder)).toThrow(/already registered/);
    fixture.snapshot(3, {
      creates: [2, 1, 3].map((entity) => ({
        entity,
        components:
          entity === 3 ? [regionOf('cell/0_0')] : [regionOf('cell/0_0'), comp(Health, { hp: 1 })],
      })),
    });
    fixture.setRenderTick(3);
    world.update(DT);
    calls.length = 0;
    off();
    off();
    expect(brief(calls)).toEqual(['health detach 1', 'health detach 2']);
    world.update(DT);
    expect(calls).toHaveLength(2);
    expect(world.view(1)?.attached.size).toBe(0);
  });

  it('a binder registered while views exist attaches on the next update', () => {
    const { fixture, world } = setup();
    fixture.snapshot(3, { creates: [{ entity: 1, components: [regionOf('cell/0_0')] }] });
    fixture.setRenderTick(3);
    world.update(DT);
    const calls: Call[] = [];
    world.registerBinder(recorder('region', Region, calls));
    expect(calls).toEqual([]);
    world.update(DT);
    expect(brief(calls)).toEqual(['region attach 1', 'region update 1 latest']);
  });

  it('core and game binders fit Binder<unknown>[] and register in createClient order', () => {
    const { fixture, world } = setup();
    const calls: Call[] = [];
    // The shape of CreateClientOpts.binders (docs/game.md §4): typechecked by `pnpm typecheck`.
    const binders: Binder<unknown>[] = [
      new RegionBinder(world),
      new TransformBinder(),
      new ModelBinder(world),
      recorder('health', Health, calls),
    ];
    for (const b of binders) world.registerBinder(b);
    fixture.snapshot(3, {
      creates: [
        {
          entity: 1,
          components: [
            regionOf('cell/0_0'),
            transformAt({ x: 1, y: 2, z: 3 }),
            comp(Model, { asset: 'vehicle', variant: 0 }),
            comp(Health, { hp: 9 }),
          ],
        },
      ],
    });
    fixture.setRenderTick(3);
    world.update(DT);
    const view = world.view(1)!;
    expect(view.attached.size).toBe(4);
    expect(view.object.parent).toBe(world.regionGroup('cell/0_0'));
    expect(view.object.position.toArray()).toEqual([1, 2, 3]);
    expect(placeholderOf(view)).toBeDefined();
    expect(brief(calls)).toEqual(['health attach 1', 'health update 1 latest']);
  });
});

describe('TransformBinder', () => {
  it('writes the sampled position and rotation: the midpoint of two samples at the midpoint tick', () => {
    const { fixture, world } = setup();
    world.registerBinder(new TransformBinder());
    const quarterTurn = q.fromAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI / 2);
    fixture.snapshot(3, {
      creates: [
        { entity: 1, components: [regionOf('cell/1_1'), transformAt({ x: 0, y: 0, z: 0 })] },
      ],
    });
    fixture.snapshot(6, {
      updates: [{ entity: 1, components: [transformAt({ x: 10, y: -4, z: 2 }, quarterTurn)] }],
    });

    const expectQuat = (
      actual: { x: number; y: number; z: number; w: number },
      want: Quat,
    ): void => {
      expect(actual.x).toBeCloseTo(want.x, 12);
      expect(actual.y).toBeCloseTo(want.y, 12);
      expect(actual.z).toBeCloseTo(want.z, 12);
      expect(actual.w).toBeCloseTo(want.w, 12);
    };

    fixture.setRenderTick(3);
    world.update(DT);
    const object = world.view(1)!.object;
    expect(object.position.toArray()).toEqual([0, 0, 0]);
    expectQuat(object.quaternion, q.identity());

    fixture.setRenderTick(4.5);
    world.update(DT);
    expect(object.position.toArray()).toEqual([5, -2, 1]);
    expectQuat(object.quaternion, q.fromAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI / 4));

    fixture.setRenderTick(6);
    world.update(DT);
    expect(object.position.toArray()).toEqual([10, -4, 2]);
    expectQuat(object.quaternion, quarterTurn);

    // Region-local: the world position adds the region origin through the group.
    const worldPos = object.getWorldPosition(object.position.clone());
    expect(worldPos.toArray()).toEqual([256 + 10, -4, 256 + 2]);
  });
});

describe('ModelBinder without an AssetLoader (placeholder only)', () => {
  function modelSetup(): ReturnType<typeof setup> {
    const s = setup();
    s.world.registerBinder(new ModelBinder(s.world));
    s.fixture.snapshot(3, {
      creates: [1, 2].map((entity) => ({
        entity,
        components: [regionOf('cell/0_0'), comp(Model, { asset: 'crate', variant: 0 })],
      })),
    });
    s.fixture.setRenderTick(3);
    s.world.update(DT);
    return s;
  }

  it('shows a 1 m magenta wireframe box named placeholder while Model is present', () => {
    const { world } = modelSetup();
    const view = world.view(1);
    const placeholder = placeholderOf(view);
    expect(placeholder).toBeInstanceOf(Mesh);
    const mesh = placeholder as Mesh<BoxGeometry, MeshBasicMaterial>;
    expect(mesh.geometry).toBeInstanceOf(BoxGeometry);
    expect(mesh.geometry.parameters).toMatchObject({ width: 1, height: 1, depth: 1 });
    expect(mesh.material).toBeInstanceOf(MeshBasicMaterial);
    expect(mesh.material.wireframe).toBe(true);
    expect(mesh.material.color.getHex()).toBe(0xff00ff);
    expect(mesh.position.toArray()).toEqual([0, 0, 0]);
    expect(view?.model).toBeUndefined();

    const other = placeholderOf(world.view(2)) as Mesh;
    expect(other).not.toBe(mesh);
    expect(other.geometry).toBe(mesh.geometry);
    expect(other.material).toBe(mesh.material);
    expect(defaultPlaceholder().geometry).toBe(mesh.geometry);
  });

  it('keeps the placeholder on a variant change and replaces it on an asset change', () => {
    const { fixture, world } = modelSetup();
    const first = placeholderOf(world.view(1));
    fixture.snapshot(6, {
      updates: [{ entity: 1, components: [comp(Model, { asset: 'crate', variant: 3 })] }],
    });
    fixture.setRenderTick(6);
    world.update(DT);
    expect(placeholderOf(world.view(1))).toBe(first);

    fixture.snapshot(9, {
      updates: [{ entity: 1, components: [comp(Model, { asset: 'barrel', variant: 3 })] }],
    });
    world.update(DT);
    expect(placeholderOf(world.view(1))).toBe(first); // not before the render tick reaches it
    fixture.setRenderTick(9);
    world.update(DT);
    const second = placeholderOf(world.view(1));
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    expect(first?.parent).toBeNull();
  });

  it('removes the placeholder on detach and disposes nothing shared', () => {
    const { fixture, world } = modelSetup();
    const mesh = placeholderOf(world.view(1)) as Mesh<BoxGeometry, MeshBasicMaterial>;
    const geometryDispose = vi.spyOn(mesh.geometry, 'dispose');
    const materialDispose = vi.spyOn(mesh.material, 'dispose');

    fixture.snapshot(6, { updates: [{ entity: 1, removed: [Model] }], destroys: [2] });
    const mesh2 = placeholderOf(world.view(2));
    fixture.setRenderTick(6);
    world.update(DT);
    expect(mesh.parent).toBeNull();
    expect(placeholderOf(world.view(1))).toBeUndefined();
    expect(world.view(1)?.data).toEqual({});
    expect(mesh2?.parent).toBeNull();
    expect(world.view(2)).toBeUndefined();
    expect(geometryDispose).not.toHaveBeenCalled();
    expect(materialDispose).not.toHaveBeenCalled();
  });

  it('uses the placeholder option, and a later binder sees the placeholder in onAttach', () => {
    const made: string[] = [];
    const seen: (Object3D | undefined)[] = [];
    const s = setup();
    s.world.registerBinder(
      new ModelBinder(s.world, {
        placeholder: (view, m) => {
          made.push(`${view.id} ${m.asset} ${m.variant}`);
          return new Group();
        },
      }),
    );
    s.world.registerBinder<{ asset: string; variant: number }>({
      component: Model,
      onAttach: (view) => seen.push(placeholderOf(view)),
    });
    s.fixture.snapshot(3, {
      creates: [
        {
          entity: 4,
          components: [regionOf('cell/0_0'), comp(Model, { asset: 'ship', variant: 2 })],
        },
      ],
    });
    s.fixture.setRenderTick(3);
    s.world.update(DT);
    expect(made).toEqual(['4 ship 2']);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(Group);
    expect(seen[0]?.name).toBe('placeholder');
  });
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  AssetLoader,
  COLLIDER_RE,
  type AssetHandle,
  type AssetId,
  type Manifest,
  type ModelMeta,
  type Priority,
} from '@conduit/assets';
import { Model } from '@conduit/sim';
import {
  AnimationClip,
  Bone,
  BoxGeometry,
  Group,
  LOD,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  Skeleton,
  SkinnedMesh,
  VectorKeyframeTrack,
} from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GltfBackend,
  ModelBinder,
  type EntityView,
  type GltfAsset,
  type ModelBinderOptions,
  type ModelInstance,
} from '../src/index.ts';
import { comp, createWorld, regionOf, ReplicaFixture } from './replica-fixture.ts';

const DT = 1 / 60;
const SHIP = 'ship.sloop';

class FakeHandle<T> implements AssetHandle<T> {
  releases = 0;
  constructor(
    readonly id: AssetId,
    readonly asset: T,
  ) {}

  release(): void {
    this.releases += 1;
  }
}

interface PendingAcquire {
  readonly id: AssetId;
  readonly priority: Priority | undefined;
  settled: boolean;
  resolve(asset: unknown): FakeHandle<unknown>;
  reject(err: Error): void;
}

const EMPTY_MANIFEST: Manifest = { version: 1, baseUrl: '/', assets: {}, groups: {}, regions: {} };

/**
 * A fake `AssetLoader` (docs/render.md §10.2): the two methods render calls are replaced by
 * acquires that stay pending until the test resolves or rejects them, with countable handles.
 */
class FakeLoader extends AssetLoader {
  readonly acquires: PendingAcquire[] = [];
  readonly handles: FakeHandle<unknown>[] = [];

  constructor() {
    super(EMPTY_MANIFEST, []);
  }

  override acquire<T = unknown>(id: AssetId, priority?: Priority): Promise<AssetHandle<T>> {
    return new Promise<AssetHandle<T>>((resolve, reject) => {
      const pending: PendingAcquire = {
        id,
        priority,
        settled: false,
        resolve: (asset) => {
          pending.settled = true;
          const handle = new FakeHandle(id, asset as T);
          this.handles.push(handle);
          resolve(handle);
          return handle;
        },
        reject: (err) => {
          pending.settled = true;
          reject(err);
        },
      };
      this.acquires.push(pending);
    });
  }

  override stats(): { queuedHigh: number; queuedLow: number; inFlight: number; loaded: number } {
    const inFlight = this.acquires.filter((a) => !a.settled).length;
    return { queuedHigh: 0, queuedLow: 0, inFlight, loaded: this.handles.length };
  }

  /** Resolves every pending acquire of `id` with `asset`; returns the handles given out. */
  resolve(id: AssetId, asset: unknown): FakeHandle<unknown>[] {
    return this.acquires.filter((a) => a.id === id && !a.settled).map((a) => a.resolve(asset));
  }

  reject(id: AssetId, err: Error): void {
    for (const a of this.acquires) if (a.id === id && !a.settled) a.reject(err);
  }
}

/** Lets settled acquire promises run their callbacks. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface ShipTemplate {
  asset: GltfAsset;
  geometry: BoxGeometry;
  material: MeshBasicMaterial;
}

/**
 * A hand-built `GltfAsset` shaped like `GLTFLoader` output for the assets fixture: scene group, root
 * `ship_sloop` with three LODs, two colliders (one with Blender's `.001` suffix, which GLTFLoader
 * strips from `name` and keeps in `userData.name`), a socket under a nested empty, two clips.
 */
function shipTemplate(): ShipTemplate {
  const geometry = new BoxGeometry();
  const material = new MeshBasicMaterial();
  const scene = new Group();
  scene.name = 'Scene';
  const root = new Group();
  root.name = 'ship_sloop';
  root.position.set(0, 1, 0);
  scene.add(root);
  for (const level of [0, 1, 2]) {
    const mesh = new Mesh(geometry, material);
    mesh.name = `ship_sloop_LOD${level}`;
    root.add(mesh);
  }
  const box = new Mesh(geometry, material);
  box.name = 'ship_sloop_COL_box001';
  box.userData['name'] = 'ship_sloop_COL_box.001';
  const sphere = new Mesh(geometry, material);
  sphere.name = 'ship_sloop_COL_sphere';
  const mast = new Object3D();
  mast.name = 'mast';
  const socket = new Object3D();
  socket.name = 'SOCKET_cannon_l';
  mast.add(socket);
  root.add(box, sphere, mast);
  const idle = new AnimationClip('idle', 1, []);
  const sail = new AnimationClip('sail', 1, [
    new VectorKeyframeTrack('mast.position', [0, 1], [0, 0, 0, 0, 4, 0]),
  ]);
  const meta: ModelMeta = {
    id: SHIP,
    root: 'ship_sloop',
    rootNode: 0,
    nodes: [],
    scenes: [{ name: 'Scene', nodes: [0] }],
    animations: ['idle', 'sail'],
    lods: [
      { name: 'ship_sloop_LOD0', node: 1, distance: 0 },
      { name: 'ship_sloop_LOD1', node: 2, distance: 50 },
      { name: 'ship_sloop_LOD2', node: 3, distance: 200 },
    ],
    colliders: [],
    sockets: [],
    extras: {},
  };
  return { asset: { scene, animations: [idle, sail], meta }, geometry, material };
}

function setup(opts: ModelBinderOptions = {}): ReturnType<typeof createWorld> & {
  loader: FakeLoader;
} {
  const loader = new FakeLoader();
  const s = createWorld(new ReplicaFixture(), {}, loader);
  s.world.registerBinder(new ModelBinder(s.world, opts));
  return { ...s, loader };
}

function modelOf(asset: AssetId, variant = 0): ReturnType<typeof comp> {
  return comp(Model, { asset, variant });
}

function placeholderOf(view: EntityView): Object3D | undefined {
  return view.object.children.find((c) => c.name === 'placeholder');
}

function nodeIn(root: Object3D, name: string): Object3D {
  const node = root.getObjectByName(name);
  expect(node, name).toBeDefined();
  return node as Object3D;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ModelBinder with an AssetLoader', () => {
  it('shows the placeholder until the acquire resolves, then the clone; modelReady once', async () => {
    const { fixture, world, loader } = setup();
    const ready: { view: EntityView; model: ModelInstance }[] = [];
    world.on('modelReady', (e) => ready.push(e));
    fixture.snapshot(3, {
      creates: [{ entity: 1, components: [regionOf('cell/0_0'), modelOf(SHIP, 2)] }],
    });
    fixture.setRenderTick(3);
    world.update(DT);
    const view = world.view(1)!;
    const placeholder = placeholderOf(view);
    expect(placeholder).toBeDefined();
    expect(loader.acquires.map((a) => [a.id, a.priority])).toEqual([[SHIP, 'high']]);

    world.update(DT);
    await flush();
    expect(placeholderOf(view)).toBe(placeholder);
    expect(view.model).toBeUndefined();
    expect(loader.acquires).toHaveLength(1); // one acquire per attach, not per frame

    const { asset, geometry } = shipTemplate();
    const [handle] = loader.resolve(SHIP, asset);
    await flush();
    const model = view.model!;
    expect(model).toBeDefined();
    expect(placeholder?.parent).toBeNull();
    expect(placeholderOf(view)).toBeUndefined();
    expect(model.root.parent).toBe(view.object);
    expect(model.root).not.toBe(asset.scene);
    expect(model.handle).toBe(handle);
    expect(model.meta).toBe(asset.meta);
    expect(model.variant).toBe(2);
    expect(model.skinned).toBe(false);
    expect((nodeIn(model.root, 'ship_sloop_LOD1') as Mesh).geometry).toBe(geometry); // shared
    expect(ready).toEqual([{ view, model }]);

    for (let i = 0; i < 5; i++) world.update(DT);
    await flush();
    expect(ready).toHaveLength(1);
    expect(loader.acquires).toHaveLength(1);
  });

  it('hides _COL_ nodes, collects sockets, builds a LOD at the meta distances, keys clips by name', async () => {
    const { fixture, world, loader } = setup();
    fixture.snapshot(3, {
      creates: [{ entity: 1, components: [regionOf('cell/0_0'), modelOf(SHIP)] }],
    });
    fixture.setRenderTick(3);
    world.update(DT);
    const { asset } = shipTemplate();
    loader.resolve(SHIP, asset);
    await flush();
    const model = world.view(1)!.model!;

    const shipRoot = nodeIn(model.root, 'ship_sloop');
    expect(nodeIn(model.root, 'ship_sloop_COL_box001').visible).toBe(false);
    expect(nodeIn(model.root, 'ship_sloop_COL_sphere').visible).toBe(false);
    expect(nodeIn(asset.scene, 'ship_sloop_COL_box001').visible).toBe(true); // template untouched
    expect(nodeIn(model.root, 'mast').visible).toBe(true);

    expect([...model.sockets.keys()]).toEqual(['cannon_l']);
    const socket = model.sockets.get('cannon_l')!;
    expect(socket).toBe(nodeIn(model.root, 'SOCKET_cannon_l'));
    expect(socket).not.toBe(nodeIn(asset.scene, 'SOCKET_cannon_l'));

    const lod = model.lod!;
    expect(lod).toBeInstanceOf(LOD);
    expect(lod.name).toBe('ship_sloop_LOD');
    expect(lod.parent).toBe(shipRoot);
    expect(lod.levels.map((l) => [l.object.name, l.distance])).toEqual([
      ['ship_sloop_LOD0', 0],
      ['ship_sloop_LOD1', 50],
      ['ship_sloop_LOD2', 200],
    ]);
    expect(lod.levels.every((l) => l.object.parent === lod)).toBe(true);
    expect(shipRoot.children.filter((c) => /_LOD\d$/.test(c.name))).toEqual([]);

    expect([...model.clips.keys()]).toEqual(['idle', 'sail']);
    expect(model.clips.get('sail')).toBe(asset.animations[1]);
    expect(model.mixer.getRoot()).toBe(model.root);

    // The mixer runs on the clone with world.frameDt.
    model.mixer.clipAction(model.clips.get('sail')!).play();
    world.update(0.5);
    expect(nodeIn(model.root, 'mast').position.y).toBeCloseTo(2, 9);
    expect(nodeIn(asset.scene, 'mast').position.y).toBe(0);
  });

  it('a model without LODs has lod null and keeps its meshes in place', async () => {
    const { fixture, world, loader } = setup();
    fixture.snapshot(3, {
      creates: [{ entity: 1, components: [regionOf('cell/0_0'), modelOf('crate')] }],
    });
    fixture.setRenderTick(3);
    world.update(DT);
    const scene = new Group();
    const crate = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
    crate.name = 'crate';
    scene.add(crate);
    const meta = { ...shipTemplate().asset.meta, id: 'crate', root: 'crate', lods: [] };
    loader.resolve('crate', { scene, animations: [], meta });
    await flush();
    const model = world.view(1)!.model!;
    expect(model.lod).toBeNull();
    expect(model.sockets.size).toBe(0);
    expect(model.clips.size).toBe(0);
    expect(nodeIn(model.root, 'crate').parent).toBe(model.root);
  });

  it('calls onVariant when the model resolves and on each variant (u8) change', async () => {
    const calls: [ModelInstance, number, number][] = [];
    const { fixture, world, loader } = setup({
      onVariant: (instance, variant, view) => calls.push([instance, variant, view.id]),
    });
    fixture.snapshot(3, {
      creates: [{ entity: 4, components: [regionOf('cell/0_0'), modelOf(SHIP, 1)] }],
    });
    fixture.setRenderTick(3);
    world.update(DT);
    // A change before the model resolves is recorded, not reported: it resolves with the latest.
    fixture.snapshot(6, { updates: [{ entity: 4, components: [modelOf(SHIP, 7)] }] });
    fixture.setRenderTick(6);
    world.update(DT);
    expect(calls).toEqual([]);
    loader.resolve(SHIP, shipTemplate().asset);
    await flush();
    const model = world.view(4)!.model!;
    expect(calls).toEqual([[model, 7, 4]]);

    fixture.snapshot(9, { updates: [{ entity: 4, components: [modelOf(SHIP, 255)] }] });
    fixture.setRenderTick(9);
    world.update(DT);
    world.update(DT); // unchanged: no call
    expect(calls).toEqual([
      [model, 7, 4],
      [model, 255, 4],
    ]);
    expect(model.variant).toBe(255);
    expect(world.view(4)!.model).toBe(model);
    expect(loader.acquires).toHaveLength(1);
  });

  it('detach before resolve releases the handle on resolve without adding the clone', async () => {
    const { fixture, world, loader } = setup();
    const ready = vi.fn();
    world.on('modelReady', ready);
    fixture.snapshot(3, {
      creates: [1, 2].map((entity) => ({
        entity,
        components: [regionOf('cell/0_0'), modelOf(SHIP)],
      })),
    });
    fixture.setRenderTick(3);
    world.update(DT);
    const one = world.view(1)!;
    const two = world.view(2)!;
    expect(loader.acquires).toHaveLength(2);
    fixture.snapshot(6, { updates: [{ entity: 1, removed: [Model] }], destroys: [2] });
    fixture.setRenderTick(6);
    world.update(DT);
    expect(world.view(2)).toBeUndefined();
    expect(placeholderOf(one)).toBeUndefined();
    expect(one.data).toEqual({});

    const handles = loader.resolve(SHIP, shipTemplate().asset);
    await flush();
    expect(handles.map((h) => h.releases)).toEqual([1, 1]);
    expect(one.model).toBeUndefined();
    expect(two.model).toBeUndefined();
    expect(one.object.children).toEqual([]);
    expect(two.object.children).toEqual([]);
    expect(ready).not.toHaveBeenCalled();
  });

  it('detach after resolve releases exactly once, removes the clone and disposes no template resource', async () => {
    const { fixture, world, loader } = setup();
    fixture.snapshot(3, {
      creates: [{ entity: 1, components: [regionOf('cell/0_0'), modelOf(SHIP)] }],
    });
    fixture.snapshot(6, { destroys: [1] });
    fixture.setRenderTick(3);
    world.update(DT);
    const view = world.view(1)!;
    const { asset, geometry, material } = shipTemplate();
    const [handle] = loader.resolve(SHIP, asset);
    await flush();
    const model = view.model!;
    const action = model.mixer.clipAction(model.clips.get('sail')!).play();
    const geometryDispose = vi.spyOn(geometry, 'dispose');
    const materialDispose = vi.spyOn(material, 'dispose');

    fixture.setRenderTick(6);
    world.update(DT);
    world.update(DT);
    await flush();
    expect(handle!.releases).toBe(1);
    expect(model.root.parent).toBeNull();
    expect(view.model).toBeUndefined();
    expect(view.data).toEqual({});
    expect(action.isRunning()).toBe(false);
    expect(geometryDispose).not.toHaveBeenCalled();
    expect(materialDispose).not.toHaveBeenCalled();

    world.dispose();
    expect(handle!.releases).toBe(1);
  });

  it('an asset change releases the old model and acquires the new one; a stale resolve is released', async () => {
    const { fixture, world, loader } = setup({ priority: 'low' });
    fixture.snapshot(3, {
      creates: [{ entity: 1, components: [regionOf('cell/0_0'), modelOf(SHIP)] }],
    });
    fixture.setRenderTick(3);
    world.update(DT);
    const view = world.view(1)!;
    const [shipHandle] = loader.resolve(SHIP, shipTemplate().asset);
    await flush();
    const ship = view.model!;

    fixture.snapshot(6, { updates: [{ entity: 1, components: [modelOf('barrel')] }] });
    fixture.setRenderTick(6);
    world.update(DT);
    expect(shipHandle!.releases).toBe(1);
    expect(ship.root.parent).toBeNull();
    expect(view.model).toBeUndefined();
    expect(placeholderOf(view)).toBeDefined();
    fixture.snapshot(9, { updates: [{ entity: 1, components: [modelOf('crate')] }] });
    fixture.setRenderTick(9);
    world.update(DT);
    expect(loader.acquires.map((a) => [a.id, a.priority])).toEqual([
      [SHIP, 'low'],
      ['barrel', 'low'],
      ['crate', 'low'],
    ]);

    const [barrelHandle] = loader.resolve('barrel', shipTemplate().asset);
    await flush();
    expect(barrelHandle!.releases).toBe(1);
    expect(view.model).toBeUndefined();

    const crate = shipTemplate().asset;
    const [crateHandle] = loader.resolve('crate', crate);
    await flush();
    expect(view.model?.handle).toBe(crateHandle);
    expect(view.object.children.filter((c) => c.name === 'placeholder')).toEqual([]);
    expect(view.object.children).toEqual([view.model!.root]);
  });

  it('a failed acquire or a non-model asset keeps the placeholder and warns once per asset id', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { fixture, world, loader } = setup();
    fixture.snapshot(3, {
      creates: [1, 2, 3].map((entity) => ({
        entity,
        components: [regionOf('cell/0_0'), modelOf(entity === 3 ? 'notes' : SHIP)],
      })),
    });
    fixture.setRenderTick(3);
    world.update(DT);
    loader.reject(SHIP, new Error('404'));
    const [notesHandle] = loader.resolve('notes', { text: 'not a model' });
    await flush();
    for (const id of [1, 2, 3]) {
      expect(placeholderOf(world.view(id)!)).toBeDefined();
      expect(world.view(id)!.model).toBeUndefined();
    }
    expect(notesHandle!.releases).toBe(1);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0]?.[0])).toContain(SHIP);
    expect(String(warn.mock.calls[1]?.[0])).toContain('notes');
  });

  it('a skinned template is cloned with its own skeleton, whose bone texture detach disposes', async () => {
    const { fixture, world, loader } = setup();
    const scene = new Group();
    const rig = new Group();
    rig.name = 'rig';
    scene.add(rig);
    const bone = new Bone();
    bone.name = 'spine';
    const body = new SkinnedMesh(new BoxGeometry(), new MeshBasicMaterial());
    body.name = 'body';
    rig.add(bone, body);
    body.bind(new Skeleton([bone]));
    const meta = { ...shipTemplate().asset.meta, id: 'rig', root: 'rig', lods: [] };
    const templateSkeletonDispose = vi.spyOn(body.skeleton, 'dispose');

    fixture.snapshot(3, {
      creates: [{ entity: 1, components: [regionOf('cell/0_0'), modelOf('rig')] }],
    });
    fixture.snapshot(6, { destroys: [1] });
    fixture.setRenderTick(3);
    world.update(DT);
    const [handle] = loader.resolve('rig', { scene, animations: [], meta });
    await flush();
    const model = world.view(1)!.model!;
    expect(model.skinned).toBe(true);
    const clonedBody = nodeIn(model.root, 'body') as SkinnedMesh;
    expect(clonedBody).not.toBe(body);
    expect(clonedBody.skeleton).not.toBe(body.skeleton);
    expect(clonedBody.skeleton.bones[0]).toBe(nodeIn(model.root, 'spine'));
    expect(clonedBody.geometry).toBe(body.geometry);
    const boneTexture = clonedBody.skeleton.computeBoneTexture().boneTexture!;
    const boneTextureDispose = vi.spyOn(boneTexture, 'dispose');

    fixture.setRenderTick(6);
    world.update(DT);
    expect(handle!.releases).toBe(1);
    expect(boneTextureDispose).toHaveBeenCalledTimes(1);
    expect(templateSkeletonDispose).not.toHaveBeenCalled();
  });

  it('dispose while an acquire is in flight releases on resolve and emits nothing', async () => {
    const { fixture, world, loader } = setup();
    const ready = vi.fn();
    world.on('modelReady', ready);
    fixture.snapshot(3, {
      creates: [{ entity: 1, components: [regionOf('cell/0_0'), modelOf(SHIP)] }],
    });
    fixture.setRenderTick(3);
    world.update(DT);
    const view = world.view(1)!;
    world.dispose();
    const [handle] = loader.resolve(SHIP, shipTemplate().asset);
    await flush();
    expect(handle!.releases).toBe(1);
    expect(view.model).toBeUndefined();
    expect(ready).not.toHaveBeenCalled();
  });
});

describe('ModelBinder with AssetLoader and GltfBackend (ship_sloop.glb fixture)', () => {
  /** A path, not `new URL(..., import.meta.url)`, which Vite rewrites into a dev-server URL. */
  const FIXTURE = resolve(import.meta.dirname, '../../assets/test/fixtures/ship_sloop.glb');

  it.each([false, true])(
    'keeps live GLTF resources then returns renderer/estimate memory to baseline (budget=%s)',
    async (budget) => {
      const file = readFileSync(FIXTURE);
      const bytes = new Uint8Array(file.byteLength);
      bytes.set(file);
      const manifest: Manifest = {
        version: 1,
        baseUrl: '/assets/',
        assets: {
          [SHIP]: {
            type: 'model',
            url: 'ship_sloop.glb',
            hash: `sha256-${'A'.repeat(43)}=`,
            size: 0,
          },
        },
        groups: {},
        regions: {},
      };
      const timers: (() => void)[] = [];
      const loader = new AssetLoader(manifest, [new GltfBackend()], {
        fetch: async () => new Response(bytes.slice(0)),
        ...(budget ? { memoryBudget: { hard: { gpuBytes: 0 } } } : {}),
        setTimer: (fn) => timers.push(fn),
        clearTimer: () => {},
      });
      const { fixture, world, host, frames, renderer } = createWorld(
        new ReplicaFixture(),
        {},
        loader,
      );
      world.registerBinder(new ModelBinder(world));
      const ready = new Promise<ModelInstance>((done) =>
        world.on('modelReady', (e) => done(e.model)),
      );
      fixture.snapshot(3, {
        creates: [{ entity: 1, components: [regionOf('cell/0_0'), modelOf(SHIP)] }],
      });
      fixture.setRenderTick(3);
      world.update(DT);
      expect(loader.refcount(SHIP)).toBe(1); // taken as soon as acquire is called
      const model = await ready;
      expect(world.view(1)?.model).toBe(model);
      expect(loader.memoryStats().instanceOwners).toBe(1);
      expect(loader.memoryStats().cpuBytes.knownBytes).toBeGreaterThan(0);
      expect(loader.memoryStats().hardPressure).toBe(budget);

      // GLTFLoader names: ModelBinder matches the glTF names it keeps in userData.name.
      const name = (n: { name: string; userData: Record<string, unknown> }): unknown =>
        n.userData['name'];
      expect(model.lod?.levels.map((l) => [name(l.object), l.distance])).toEqual([
        ['ship_sloop_LOD0', 0],
        ['ship_sloop_LOD1', 50],
        ['ship_sloop_LOD2', 200],
      ]);
      expect(model.lod?.parent?.userData['name']).toBe('ship_sloop');
      const colliders: unknown[] = [];
      model.root.traverse((n) => {
        if (COLLIDER_RE.test(String(name(n)))) colliders.push([name(n), n.visible]);
      });
      expect(colliders).toEqual([
        ['ship_sloop_COL_box', false],
        ['ship_sloop_COL_sphere', false],
        ['ship_sloop_COL_capsule', false],
        ['ship_sloop_COL_convex.001', false],
      ]);
      expect([...model.sockets.keys()]).toEqual(['cannon_l', 'cannon_r', 'helm']);
      expect(model.sockets.get('cannon_l')?.parent?.userData['name']).toBe('deck');
      expect([...model.clips.keys()]).toEqual(['idle', 'sail']);
      model.mixer.clipAction(model.clips.get('idle')!).play();
      world.update(0.5);
      const deck = model.sockets.get('helm')?.parent?.getObjectByName('deck');
      expect(deck?.position.y).toBeCloseTo(1.0625, 6); // idle: y 1 -> 1.125 over the first second

      host.start();
      frames.stepFrame();
      // The fake renderer draws all three LOD levels (only WebGLRenderer runs LOD.update); colliders are hidden.
      expect(renderer.info.memory.geometries).toBe(3);

      fixture.snapshot(6, { destroys: [1] });
      fixture.setRenderTick(6);
      world.update(DT);
      expect(model.root.parent).toBeNull();
      expect(loader.refcount(SHIP)).toBe(0);
      expect(loader.state(SHIP)).toBe(budget ? 'idle' : 'grace');
      expect(loader.memoryStats().instanceOwners).toBe(0);
      frames.stepFrame();
      expect(renderer.info.memory.geometries).toBe(budget ? 0 : 3); // live handles prevented pressure eviction earlier

      for (const expire of timers.splice(0)) expire();
      expect(loader.state(SHIP)).toBe('idle');
      expect(renderer.info.memory.geometries).toBe(0);
      expect(loader.memoryStats().resources).toBe(0);
      host.dispose();
    },
  );
});

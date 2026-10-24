import {
  COLLIDER_RE,
  SOCKET_RE,
  type AssetHandle,
  type AssetId,
  type ModelMeta,
  type Priority,
  type ResourceOwner,
} from '@conduit/assets';
import { Model } from '@conduit/sim';
import {
  AnimationMixer,
  BoxGeometry,
  LOD,
  Mesh,
  MeshBasicMaterial,
  type AnimationClip,
  type Object3D,
  type Skeleton,
  type SkinnedMesh,
} from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { estimateInstanceResources } from '../resource-estimates.ts';
import type { GltfAsset } from '../gltf-backend.ts';
import type { Binder, EntityView } from '../view.ts';
import type { RenderWorld } from '../world.ts';

/** The `Model` component's value: `{ asset: AssetId; variant: number }` (`variant` is u8). */
export type ModelComponent = ReturnType<typeof Model.create>;

/** A per-view clone of a model template (docs/render.md §4.3); `view.model` once resolved. */
export interface ModelInstance {
  /** The clone of the template scene, child of `view.object`. */
  root: Object3D;
  /** Present when `meta.lods.length > 0`: the `_LODn` nodes of the clone as levels. */
  lod: LOD | null;
  /** Socket name without `SOCKET_` -> node in the clone. */
  sockets: Map<string, Object3D>;
  /** Bound to `root`; advanced by `world.frameDt` every frame. */
  mixer: AnimationMixer;
  /** The template's clips by name (shared, read-only). */
  clips: Map<string, AnimationClip>;
  meta: ModelMeta;
  handle: AssetHandle<GltfAsset>;
  variant: number;
  /** The template has a `SkinnedMesh`, so the clone owns its skeletons. */
  skinned: boolean;
}

export interface ModelBinderOptions {
  /** Shown until the model resolves (and kept if it fails); default `defaultPlaceholder`. */
  placeholder?: (view: EntityView, value: Readonly<ModelComponent>) => Object3D;
  /** Called when a model resolves and when `variant` changes on a resolved model. */
  onVariant?: (instance: ModelInstance, variant: number, view: EntityView) => void;
  /** `AssetLoader.acquire` priority; default `'high'`. */
  priority?: Priority;
}

/**
 * Stored in `view.data` under `STATE_KEY` while the binder is attached; a new object per attach, so
 * an acquire that resolves after its state was replaced or removed releases its handle.
 */
interface ModelState {
  /** Until the model resolves; null afterwards. */
  placeholder: Object3D | null;
  instance: ModelInstance | null;
  asset: AssetId;
  variant: number;
}

const STATE_KEY = '__model';
const PLACEHOLDER_NAME = 'placeholder';
const PLACEHOLDER_COLOR = 0xff00ff;

let sharedGeometry: BoxGeometry | null = null;
let sharedMaterial: MeshBasicMaterial | null = null;

/**
 * A 1 m magenta (`0xff00ff`) wireframe box centred on the entity. Every placeholder shares one
 * module-level `BoxGeometry` and `MeshBasicMaterial`, created on first use and never disposed, so
 * removing a placeholder disposes nothing. A binder that restyles a placeholder assigns its own
 * material (and disposes it itself) instead of mutating the shared one.
 */
export function defaultPlaceholder(
  _view?: EntityView,
  _value?: Readonly<ModelComponent>,
): Mesh<BoxGeometry, MeshBasicMaterial> {
  sharedGeometry ??= new BoxGeometry(1, 1, 1);
  sharedMaterial ??= new MeshBasicMaterial({ color: PLACEHOLDER_COLOR, wireframe: true });
  return new Mesh(sharedGeometry, sharedMaterial);
}

function stateOf(view: EntityView): ModelState | undefined {
  return view.data[STATE_KEY] as ModelState | undefined;
}

/**
 * The glTF node name: `GLTFLoader` keeps it in `userData.name` and sanitises `name` (it drops `.`,
 * so `ship_COL_box.001` becomes `ship_COL_box001`, and suffixes duplicates). Hand-built templates
 * only have `name`.
 */
function gltfName(node: Object3D): string {
  const original: unknown = node.userData['name'];
  return typeof original === 'string' ? original : node.name;
}

function isGltfAsset(asset: unknown): asset is GltfAsset {
  if (typeof asset !== 'object' || asset === null) return false;
  const a = asset as Partial<Record<keyof GltfAsset, unknown>>;
  return (
    (a.scene as Object3D | undefined)?.isObject3D === true &&
    Array.isArray(a.animations) &&
    typeof a.meta === 'object' &&
    a.meta !== null
  );
}

function hasSkinnedMesh(root: Object3D): boolean {
  let found = false;
  root.traverse((node) => {
    if ((node as SkinnedMesh).isSkinnedMesh === true) found = true;
  });
  return found;
}

/** The first node under `root` (pre-order, `root` excluded) whose glTF name is `name`. */
function findByGltfName(root: Object3D, name: string): Object3D | undefined {
  const stack = [...root.children].reverse();
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (gltfName(node) === name) return node;
    for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i] as Object3D);
  }
  return undefined;
}

/** Clones the template for one view: hidden colliders, sockets, LOD levels, a mixer on the clone. */
function instantiate(handle: AssetHandle<GltfAsset>, variant: number): ModelInstance {
  const template = handle.asset;
  const meta = template.meta;
  const skinned = hasSkinnedMesh(template.scene);
  // Geometries, materials and textures stay shared with the template; skinned clones get their own
  // skeletons bound to the cloned bones.
  const root = skinned ? cloneSkinned(template.scene) : template.scene.clone(true);
  const sockets = new Map<string, Object3D>();
  root.traverse((node) => {
    const name = gltfName(node);
    if (COLLIDER_RE.test(name)) node.visible = false;
    const socket = SOCKET_RE.exec(name);
    if (socket !== null) sockets.set(socket[1] as string, node);
  });
  let lod: LOD | null = null;
  if (meta.lods.length > 0) {
    lod = new LOD();
    lod.name = `${meta.root}_LOD`;
    // The levels are direct children of the root node: the LOD takes their place there, so the
    // root's transform still applies to them.
    let parent: Object3D | null = null;
    for (const level of meta.lods) {
      const node = findByGltfName(root, level.name);
      if (node === undefined) continue;
      parent ??= node.parent;
      lod.addLevel(node, level.distance);
    }
    (parent ?? root).add(lod);
  }
  const mixer = new AnimationMixer(root);
  const clips = new Map(template.animations.map((clip) => [clip.name, clip]));
  return { root, lod, sockets, mixer, clips, meta, handle, variant, skinned };
}

/** Disposes what a clone owns: the skeletons `SkeletonUtils.clone` created (their bone textures). */
function disposeCloneOwned(root: Object3D): void {
  const skeletons = new Set<Skeleton>();
  root.traverse((node) => {
    const skinned = node as SkinnedMesh;
    if (skinned.isSkinnedMesh === true) skeletons.add(skinned.skeleton);
  });
  for (const skeleton of skeletons) skeleton.dispose();
}

/**
 * Binds `Model` to a view (docs/render.md §4.3). On attach it shows the placeholder (named
 * `placeholder`, child of `view.object`) and acquires the asset from `world.assets`; when the
 * `GltfAsset` resolves it clones the template into `view.model` (colliders hidden, sockets, LOD
 * levels at the meta distances, an `AnimationMixer` advanced by `world.frameDt`), removes the
 * placeholder, calls `onVariant` and emits `modelReady`. An `asset` change starts over; a `variant`
 * change calls `onVariant` on the resolved model. Detach releases the handle exactly once (an
 * acquire still in flight releases when it resolves) and removes the clone; the template's
 * geometry, materials and textures are the loader's to dispose. Without `world.assets`, or when the
 * acquire fails (warned once per asset id), the placeholder stays.
 */
export class ModelBinder implements Binder<ModelComponent> {
  readonly component = Model;
  private readonly world: RenderWorld;
  private readonly makePlaceholder: (view: EntityView, value: Readonly<ModelComponent>) => Object3D;
  private readonly onVariant: ModelBinderOptions['onVariant'];
  private readonly priority: Priority;
  private readonly instanceResources = new WeakMap<
    ModelInstance,
    { owner: ResourceOwner; skeletons: Skeleton[]; buffers: object[] }
  >();
  private readonly warned = new Set<AssetId>();

  constructor(world: RenderWorld, opts: ModelBinderOptions = {}) {
    this.world = world;
    this.makePlaceholder = opts.placeholder ?? defaultPlaceholder;
    this.onVariant = opts.onVariant;
    this.priority = opts.priority ?? 'high';
  }

  onAttach(view: EntityView, m: Readonly<ModelComponent>): void {
    const placeholder = this.makePlaceholder(view, m);
    placeholder.name = PLACEHOLDER_NAME;
    view.object.add(placeholder);
    const state: ModelState = { placeholder, instance: null, asset: m.asset, variant: m.variant };
    view.data[STATE_KEY] = state;
    this.request(view, state);
  }

  onUpdate(view: EntityView, m: Readonly<ModelComponent>): void {
    const s = stateOf(view);
    if (s === undefined || m.asset !== s.asset) {
      this.release(view);
      this.onAttach(view, m);
      return;
    }
    const instance = s.instance;
    if (m.variant !== s.variant) {
      s.variant = m.variant; // recorded before the model resolves too: it resolves with the latest
      if (instance !== null) {
        instance.variant = m.variant;
        this.onVariant?.(instance, m.variant, view);
      }
    }
    instance?.mixer.update(this.world.frameDt);
    if (instance !== null) this.refreshResources(instance);
  }

  onDetach(view: EntityView): void {
    this.release(view);
  }

  private request(view: EntityView, s: ModelState): void {
    const assets = this.world.assets;
    if (assets === undefined) return;
    const current = (): boolean => stateOf(view) === s;
    void assets.acquire<GltfAsset>(s.asset, this.priority).then(
      (handle) => {
        if (!current()) {
          handle.release(); // detached, or the asset changed, while loading
          return;
        }
        let instance: ModelInstance;
        try {
          if (!isGltfAsset(handle.asset)) {
            throw new TypeError(`asset ${s.asset} is not a GltfAsset (is its type 'model'?)`);
          }
          instance = instantiate(handle, s.variant);
          if (typeof assets.trackResources === 'function') {
            const owner = assets.trackResources(estimateInstanceResources(instance.root));
            const skeletons: Skeleton[] = [];
            if (instance.skinned)
              instance.root.traverse((node) => {
                const mesh = node as SkinnedMesh;
                if (mesh.isSkinnedMesh) skeletons.push(mesh.skeleton);
              });
            this.instanceResources.set(instance, {
              owner,
              skeletons,
              buffers: this.ownedBuffers(skeletons),
            });
          }
        } catch (err) {
          handle.release();
          this.warnOnce(s.asset, err);
          return;
        }
        view.object.add(instance.root);
        s.placeholder?.removeFromParent(); // shared geometry and material: nothing to dispose
        s.placeholder = null;
        s.instance = instance;
        view.model = instance;
        this.onVariant?.(instance, s.variant, view);
        if (current()) this.world.emit('modelReady', { view, model: instance });
      },
      (err: unknown) => {
        if (current()) this.warnOnce(s.asset, err);
      },
    );
  }

  private release(view: EntityView): void {
    const s = stateOf(view);
    if (s === undefined) return;
    delete view.data[STATE_KEY]; // an acquire still in flight sees this and releases on resolve
    const instance = s.instance;
    s.instance = null;
    if (instance !== null) {
      if (view.model === instance) view.model = undefined;
      instance.mixer.stopAllAction();
      instance.mixer.uncacheRoot(instance.root);
      instance.root.removeFromParent();
      if (instance.skinned) disposeCloneOwned(instance.root);
      this.instanceResources.get(instance)?.owner.release();
      this.instanceResources.delete(instance);
      instance.handle.release();
    }
    s.placeholder?.removeFromParent();
    s.placeholder = null;
  }

  private ownedBuffers(skeletons: readonly Skeleton[]): object[] {
    const buffers: object[] = [];
    for (const skeleton of skeletons) {
      buffers.push(skeleton.boneMatrices.buffer);
      if (skeleton.boneTexture !== null) buffers.push(skeleton.boneTexture);
    }
    return buffers;
  }

  private refreshResources(instance: ModelInstance): void {
    const tracked = this.instanceResources.get(instance);
    if (tracked === undefined || !instance.skinned) return;
    let index = 0,
      changed = false;
    for (let i = 0; i < tracked.skeletons.length; i++) {
      const skeleton = tracked.skeletons[i]!;
      if (tracked.buffers[index++] !== skeleton.boneMatrices.buffer) changed = true;
      if (skeleton.boneTexture !== null && tracked.buffers[index++] !== skeleton.boneTexture)
        changed = true;
    }
    if (changed || index !== tracked.buffers.length) {
      tracked.owner.update(estimateInstanceResources(instance.root));
      tracked.buffers = this.ownedBuffers(tracked.skeletons);
    }
  }

  private warnOnce(asset: AssetId, err: unknown): void {
    if (this.warned.has(asset)) return;
    this.warned.add(asset);
    console.warn(`ModelBinder: model ${asset} is unavailable; keeping its placeholder`, err);
  }
}

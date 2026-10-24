import { estimateGltfResources } from './resource-estimates.ts';
import {
  deriveModelMeta,
  fetchBytes,
  parseGlb,
  type AssetBackend,
  type AssetEntry,
  type BackendContext,
  type ModelMeta,
  type ResourceEstimate,
} from '@conduit/assets';
import type {
  AnimationClip,
  BufferGeometry,
  Group,
  LoadingManager,
  Material,
  Mesh,
  Skeleton,
  SkinnedMesh,
  Texture,
} from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';

/** A parsed `.glb` model template, shared by every `ModelInstance` cloned from it. */
export interface GltfAsset {
  scene: Group;
  animations: AnimationClip[];
  /** `deriveModelMeta` of the file's JSON chunk: the same derivation the server uses. */
  meta: ModelMeta;
}

export interface GltfBackendOptions {
  /** Default `new GLTFLoader(manager)`, with no DRACO loader (compression is off by convention). */
  loader?: GLTFLoader;
  /** For the default loader. */
  manager?: LoadingManager;
}

function abortError(): DOMException {
  return new DOMException('aborted', 'AbortError');
}

/**
 * The `model` backend for rendering clients (docs/render.md §5): fetches the `.glb`, derives
 * `ModelMeta` from its JSON chunk and parses it with `GLTFLoader`. `dispose` frees everything the
 * template owns: each geometry, material, texture and skeleton exactly once.
 */
export class GltfBackend implements AssetBackend<GltfAsset> {
  readonly type = 'model';
  private readonly loader: GLTFLoader;
  private readonly resourceOwners = new Map<object, number>();
  private readonly assets = new WeakMap<
    GltfAsset,
    {
      geometries: Set<BufferGeometry>;
      materials: Set<Material>;
      textures: Set<Texture>;
      skeletons: Set<Skeleton>;
    }
  >();
  private readonly disposedAssets = new WeakSet<GltfAsset>();

  constructor(opts: GltfBackendOptions = {}) {
    this.loader = opts.loader ?? new GLTFLoader(opts.manager);
  }

  async load(
    url: string,
    entry: AssetEntry,
    signal: AbortSignal,
    ctx: BackendContext,
  ): Promise<GltfAsset> {
    const bytes = await fetchBytes(url, entry, signal, ctx);
    if (signal.aborted) throw abortError();
    const meta = deriveModelMeta(parseGlb(bytes, { jsonOnly: true }).json, ctx.id);
    const gltf = await new Promise<GLTF>((resolve, reject) => {
      this.loader.parse(bytes, '', resolve, reject);
    });
    const asset: GltfAsset = { scene: gltf.scene, animations: gltf.animations, meta };
    this.retain(asset);
    if (signal.aborted) {
      this.dispose(asset);
      throw abortError();
    }
    return asset;
  }

  estimate(asset: GltfAsset): ResourceEstimate {
    return estimateGltfResources(asset);
  }

  private retain(asset: GltfAsset): void {
    const existing = this.assets.get(asset);
    const geometries = new Set<BufferGeometry>();
    const materials = new Set<Material>();
    const textures = new Set<Texture>();
    const skeletons = new Set<Skeleton>();
    asset.scene.traverse((node) => {
      const mesh = node as Partial<Mesh>;
      if (mesh.geometry?.isBufferGeometry === true) geometries.add(mesh.geometry);
      const material: Material | Material[] | undefined = mesh.material;
      for (const m of Array.isArray(material) ? material : material ? [material] : []) {
        materials.add(m);
      }
      const skinned = node as SkinnedMesh;
      if (skinned.isSkinnedMesh === true) skeletons.add(skinned.skeleton);
    });
    for (const material of materials) {
      // Every texture slot, including the MeshPhysicalMaterial extension maps.
      for (const value of Object.values(material)) {
        if ((value as Texture | null)?.isTexture === true) textures.add(value as Texture);
      }
    }
    const previous = new Set<object>(
      existing === undefined
        ? []
        : [
            ...existing.geometries,
            ...existing.materials,
            ...existing.textures,
            ...existing.skeletons,
          ],
    );
    for (const resource of [...geometries, ...materials, ...textures, ...skeletons])
      if (!previous.has(resource))
        this.resourceOwners.set(resource, (this.resourceOwners.get(resource) ?? 0) + 1);
    if (existing !== undefined) {
      for (const geometry of existing.geometries) geometries.add(geometry);
      for (const material of existing.materials) materials.add(material);
      for (const texture of existing.textures) textures.add(texture);
      for (const skeleton of existing.skeletons) skeletons.add(skeleton);
    }
    this.assets.set(asset, { geometries, materials, textures, skeletons });
  }

  dispose(asset: GltfAsset): void {
    if (this.disposedAssets.has(asset)) return;
    this.retain(asset);
    this.disposedAssets.add(asset);
    const owned = this.assets.get(asset)!;
    this.assets.delete(asset);
    const release = (resource: object): boolean => {
      const refs = (this.resourceOwners.get(resource) ?? 1) - 1;
      if (refs > 0) {
        this.resourceOwners.set(resource, refs);
        return false;
      }
      this.resourceOwners.delete(resource);
      return true;
    };
    for (const geometry of owned.geometries) if (release(geometry)) geometry.dispose();
    for (const texture of owned.textures) if (release(texture)) texture.dispose();
    for (const material of owned.materials) if (release(material)) material.dispose();
    for (const skeleton of owned.skeletons) if (release(skeleton)) skeleton.dispose();
  }
}

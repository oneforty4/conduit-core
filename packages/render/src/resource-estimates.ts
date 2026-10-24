import type { AssetResource, ResourceEstimate } from '@conduit/assets';
import {
  FloatType,
  HalfFloatType,
  RedFormat,
  RGFormat,
  RGBAFormat,
  UnsignedByteType,
  UnsignedIntType,
  UnsignedShortType,
  type Object3D,
  type Mesh,
  type Texture,
  type SkinnedMesh,
  type BufferAttribute,
  type InterleavedBufferAttribute,
} from 'three';
import type { GltfAsset } from './gltf-backend.ts';

/** Estimated upload bytes, not measured driver residency; unsupported formats remain unknown. */
function textureBytes(texture: Texture): number | null {
  // These layouts need backend/renderer-specific dimensional or compression accounting.
  for (const flag of [
    'isData3DTexture',
    'isDataArrayTexture',
    'isCompressedTexture',
    'isCubeTexture',
    'isDepthTexture',
    'isVideoTexture',
  ])
    if (Reflect.get(texture, flag) === true) return null;
  const mipmaps = texture.mipmaps as Array<{ data?: ArrayBufferView }>;
  if (
    !texture.generateMipmaps &&
    mipmaps.length > 0 &&
    mipmaps.every((mipmap) => ArrayBuffer.isView(mipmap.data))
  )
    return mipmaps.reduce((bytes, mipmap) => bytes + mipmap.data!.byteLength, 0);
  const image: unknown = texture.image;
  if (image === null || typeof image !== 'object') return null;
  const width: unknown = Reflect.get(image, 'width'),
    height: unknown = Reflect.get(image, 'height');
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    (width as number) < 1 ||
    (height as number) < 1
  )
    return null;
  const channels =
    texture.format === RGBAFormat
      ? 4
      : texture.format === RGFormat
        ? 2
        : texture.format === RedFormat
          ? 1
          : null;
  const bytes =
    texture.type === UnsignedByteType
      ? 1
      : texture.type === HalfFloatType || texture.type === UnsignedShortType
        ? 2
        : texture.type === FloatType || texture.type === UnsignedIntType
          ? 4
          : null;
  if (channels === null || bytes === null) return null;
  let w = width as number,
    h = height as number,
    total = w * h * channels * bytes;
  if (texture.generateMipmaps)
    while (w > 1 || h > 1) {
      w = Math.max(1, Math.floor(w / 2));
      h = Math.max(1, Math.floor(h / 2));
      total += w * h * channels * bytes;
    }
  return Number.isSafeInteger(total) ? total : null;
}
class Estimates {
  readonly resources = new Map<object, AssetResource>();
  add(
    identity: object,
    cpuBytes: number | null,
    gpuBytes: number | null,
    retainedSourceBytes: number | null = 0,
  ): void {
    const previous = this.resources.get(identity);
    const maximum = (a: number | null, b: number | null): number | null =>
      a === null || b === null ? null : Math.max(a, b);
    this.resources.set(
      identity,
      previous === undefined
        ? { identity, cpuBytes, gpuBytes, retainedSourceBytes }
        : {
            identity,
            cpuBytes: maximum(previous.cpuBytes, cpuBytes),
            gpuBytes: maximum(previous.gpuBytes, gpuBytes),
            retainedSourceBytes: maximum(previous.retainedSourceBytes, retainedSourceBytes),
          },
    );
  }
  buffer(array: ArrayBufferView): void {
    if (!ArrayBuffer.isView(array)) return; // JS animation arrays are covered by unknown object overhead.
    this.add(array.buffer, array.buffer.byteLength, 0);
  }
  texture(texture: Texture): void {
    this.add(texture, 0, textureBytes(texture));
    const image: unknown = texture.image;
    if (
      image !== null &&
      typeof image === 'object' &&
      ArrayBuffer.isView(Reflect.get(image, 'data'))
    )
      this.buffer(Reflect.get(image, 'data') as ArrayBufferView);
    else this.add(texture, null, textureBytes(texture));
    for (const mipmap of texture.mipmaps as Array<{ data?: ArrayBufferView }>)
      if (mipmap.data !== undefined && ArrayBuffer.isView(mipmap.data)) this.buffer(mipmap.data);
  }
  skeleton(node: SkinnedMesh): void {
    this.buffer(node.skeleton.boneMatrices);
    if (node.skeleton.boneTexture !== null) this.texture(node.skeleton.boneTexture);
  }
  result(): ResourceEstimate {
    return { resources: [...this.resources.values()] };
  }
}

/** Shared template identity accounting: buffers/textures deduplicate across meshes and asset owners. */
export function estimateGltfResources(asset: GltfAsset): ResourceEstimate {
  const estimates = new Estimates();
  // JS graph overhead and retained parser/source storage cannot be inferred from typed buffers.
  estimates.add(asset, null, 0, null);
  asset.scene.traverse((node) => {
    const mesh = node as Partial<Mesh>;
    if (mesh.geometry !== undefined) {
      const attributes = [
        ...Object.values(mesh.geometry.attributes),
        ...Object.values(mesh.geometry.morphAttributes).flat(),
        ...(mesh.geometry.index === null ? [] : [mesh.geometry.index]),
      ];
      for (const attribute of attributes) {
        const input = attribute as BufferAttribute | InterleavedBufferAttribute;
        const buffer =
          'isInterleavedBufferAttribute' in input && input.isInterleavedBufferAttribute
            ? input.data
            : (input as BufferAttribute);
        if (ArrayBuffer.isView(buffer.array)) {
          estimates.buffer(buffer.array);
          estimates.add(buffer, 0, buffer.array.byteLength);
        } else estimates.add(buffer, null, null);
      }
    }
    for (const material of Array.isArray(mesh.material)
      ? mesh.material
      : mesh.material
        ? [mesh.material]
        : []) {
      // Compiled shader/program cost and sharing are renderer/driver dependent.
      estimates.add(material, 0, null);
      for (const value of Object.values(material))
        if ((value as Texture | null)?.isTexture === true) estimates.texture(value as Texture);
    }
    if ((node as SkinnedMesh).isSkinnedMesh) estimates.skeleton(node as SkinnedMesh);
  });
  for (const clip of asset.animations)
    for (const track of clip.tracks) {
      estimates.buffer(track.times);
      estimates.buffer(track.values);
    }
  return estimates.result();
}

/** A clone owns its skeleton buffers/textures. Materials/geometries/textures remain template-owned. */
export function estimateInstanceResources(root: Object3D): ResourceEstimate {
  const estimates = new Estimates();
  estimates.add(root, null, 0);
  root.traverse((node) => {
    if ((node as SkinnedMesh).isSkinnedMesh) estimates.skeleton(node as SkinnedMesh);
  });
  return estimates.result();
}

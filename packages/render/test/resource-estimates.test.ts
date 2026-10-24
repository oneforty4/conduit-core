import { ResourceLedger, deriveModelMeta } from '@conduit/assets';
import {
  Bone,
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  Data3DTexture,
  DataArrayTexture,
  Group,
  Mesh,
  MeshBasicMaterial,
  RGBAFormat,
  Skeleton,
  SkinnedMesh,
  UnsignedByteType,
} from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { describe, expect, it } from 'vitest';
import { estimateGltfResources, estimateInstanceResources, type GltfAsset } from '../src/index.ts';
function template() {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(9), 3));
  geometry.setIndex(new BufferAttribute(new Uint16Array([0, 1, 2]), 1));
  const texture = new DataTexture(new Uint8Array(64), 4, 4, RGBAFormat, UnsignedByteType);
  texture.generateMipmaps = false;
  const material = new MeshBasicMaterial({ map: texture });
  const scene = new Group();
  scene.add(new Mesh(geometry, material), new Mesh(geometry, material));
  const asset: GltfAsset = {
    scene,
    animations: [],
    meta: deriveModelMeta({ asset: { version: '2.0' } }, 'model'),
  };
  return { asset, geometry, texture, material };
}
describe('backend resource estimates', () => {
  it('counts shared arrays/geometry/textures once while retaining explicit unknown overhead', () => {
    const { asset } = template();
    const ledger = new ResourceLedger();
    ledger.set(asset, estimateGltfResources(asset));
    const before = ledger.snapshot();
    expect(before.cpuBytes.knownBytes).toBe(106);
    expect(before.gpuBytes.knownBytes).toBe(106);
    expect(before.cpuBytes.unknownResources).toBeGreaterThan(0);
    expect(before.gpuBytes.unknownResources).toBeGreaterThan(0);
    expect(before.retainedSourceBytes.unknownResources).toBe(1);
    const a = asset.scene.clone(true),
      b = asset.scene.clone(true);
    ledger.set(a, estimateInstanceResources(a));
    ledger.set(b, estimateInstanceResources(b));
    expect(ledger.snapshot().gpuBytes.knownBytes).toBe(before.gpuBytes.knownBytes);
    ledger.delete(a);
    expect(ledger.snapshot().gpuBytes.knownBytes).toBe(before.gpuBytes.knownBytes);
    ledger.delete(b);
    ledger.delete(asset);
    expect(ledger.snapshot().resources).toBe(0);
  });
  it('keeps unsupported depth/layer texture upload costs explicitly unknown', () => {
    for (const texture of [
      new Data3DTexture(new Uint8Array(4 * 4 * 8), 4, 4, 8),
      new DataArrayTexture(new Uint8Array(4 * 4 * 4 * 8), 4, 4, 8),
    ]) {
      const { asset, material } = template();
      material.map = texture;
      const estimate = estimateGltfResources(asset);
      expect(
        estimate.resources.find((resource) => resource.identity === texture)?.gpuBytes,
      ).toBeNull();
      texture.dispose();
    }
  });

  it('counts cloned skeleton buffers and prepared bone textures as per-instance owned resources', () => {
    const geometry = new BufferGeometry();
    const material = new MeshBasicMaterial();
    const mesh = new SkinnedMesh(geometry, material);
    const bone = new Bone();
    mesh.add(bone);
    mesh.bind(new Skeleton([bone]));
    const scene = new Group();
    scene.add(mesh);
    const a = cloneSkinned(scene),
      b = cloneSkinned(scene);
    const ledger = new ResourceLedger();
    ledger.set(a, estimateInstanceResources(a));
    ledger.set(b, estimateInstanceResources(b));
    expect(ledger.snapshot().cpuBytes.knownBytes).toBe(128);
    const skeletonA = (a.children[0] as SkinnedMesh).skeleton;
    const skeletonB = (b.children[0] as SkinnedMesh).skeleton;
    skeletonA.computeBoneTexture();
    skeletonB.computeBoneTexture();
    ledger.set(a, estimateInstanceResources(a));
    ledger.set(b, estimateInstanceResources(b));
    expect(ledger.snapshot().cpuBytes.knownBytes).toBe(512);
    expect(ledger.snapshot().gpuBytes.knownBytes).toBe(512);
    skeletonA.dispose();
    ledger.delete(a);
    expect(ledger.snapshot().gpuBytes.knownBytes).toBe(256);
    skeletonB.dispose();
    ledger.delete(b);
    expect(ledger.snapshot().resources).toBe(0);
    geometry.dispose();
    material.dispose();
  });
});

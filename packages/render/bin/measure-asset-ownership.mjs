import { AssetLoader } from '../../assets/src/index.ts';
import { GltfBackend } from '../src/gltf-backend.ts';
import {
  Bone,
  Skeleton,
  SkinnedMesh,
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  Group,
  Mesh,
  MeshBasicMaterial,
  RGBAFormat,
  UnsignedByteType,
} from '../node_modules/three/build/three.module.js';
import { clone as cloneSkinned } from '../node_modules/three/examples/jsm/utils/SkeletonUtils.js';
import { GLTFLoader } from '../node_modules/three/examples/jsm/loaders/GLTFLoader.js';
function resources(scene) {
  const geometry = new Set(),
    attributes = new Set(),
    materials = new Set(),
    textures = new Set(),
    cpuBuffers = new Set();
  scene.traverse((node) => {
    if (node.geometry) {
      geometry.add(node.geometry);
      for (const attr of [...Object.values(node.geometry.attributes), node.geometry.index].filter(
        Boolean,
      )) {
        const token = attr.isInterleavedBufferAttribute ? attr.data : attr;
        attributes.add(token);
        cpuBuffers.add(token.array.buffer);
      }
    }
    for (const m of Array.isArray(node.material)
      ? node.material
      : node.material
        ? [node.material]
        : [])
      materials.add(m);
  });
  for (const m of materials)
    for (const item of Object.values(m)) if (item?.isTexture) textures.add(item);
  let knownTextureGpuBytes = 0,
    unknownTextureImages = 0;
  for (const t of textures) {
    const image = t.image;
    if (
      image?.data instanceof Uint8Array &&
      t.format === RGBAFormat &&
      t.type === UnsignedByteType &&
      t.generateMipmaps === false
    ) {
      cpuBuffers.add(image.data.buffer);
      knownTextureGpuBytes += image.width * image.height * 4;
    } else unknownTextureImages++;
  }
  return {
    geometries: geometry.size,
    materials: materials.size,
    textures: textures.size,
    knownCpuBufferBytes: [...cpuBuffers].reduce((n, b) => n + b.byteLength, 0),
    knownGpuGeometryBytes: [...attributes].reduce((n, a) => n + a.array.byteLength, 0),
    knownGpuTextureBytes: knownTextureGpuBytes,
    unknownTextureImages,
    unknown: [
      'Object3D/material/animation JS overhead',
      'compiled GPU programs, driver alignment and actual residency',
    ],
  };
}
export async function measureAssetOwnership(sources) {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(9), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(9), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(6), 2));
  geometry.setIndex(new BufferAttribute(new Uint16Array([0, 1, 2]), 1));
  const texture = new DataTexture(new Uint8Array(64), 4, 4, RGBAFormat, UnsignedByteType);
  texture.generateMipmaps = false;
  const material = new MeshBasicMaterial({ map: texture });
  const scene = new Group();
  scene.add(new Mesh(geometry, material), new Mesh(geometry, material));
  const cloneA = scene.clone(true),
    cloneB = scene.clone(true);
  const synthetic = resources(scene);
  const combined = new Group();
  combined.add(scene, cloneA, cloneB);
  const allInstances = resources(combined);
  const disposals = { geometry: 0, material: 0, texture: 0 };
  geometry.addEventListener('dispose', () => disposals.geometry++);
  material.addEventListener('dispose', () => disposals.material++);
  texture.addEventListener('dispose', () => disposals.texture++);
  new GltfBackend().dispose({ scene: combined, animations: [], meta: {} });
  const skinnedRoot = new Group();
  const bone = new Bone();
  const skeleton = new Skeleton([bone]);
  const skinnedGeometry = geometry.clone();
  const skinnedMesh = new SkinnedMesh(skinnedGeometry, material);
  skinnedMesh.add(bone);
  skinnedMesh.bind(skeleton);
  skinnedRoot.add(skinnedMesh);
  const skinA = cloneSkinned(skinnedRoot).children[0];
  const skinB = cloneSkinned(skinnedRoot).children[0];
  const beforeBoneTextures = [
    skeleton.boneMatrices.byteLength,
    skinA.skeleton.boneMatrices.byteLength,
    skinB.skeleton.boneMatrices.byteLength,
  ];
  skinA.skeleton.computeBoneTexture();
  skinB.skeleton.computeBoneTexture();
  let ownedBoneTextureDisposals = 0;
  for (const instance of [skinA, skinB])
    instance.skeleton.boneTexture.addEventListener('dispose', () => {
      ownedBoneTextureDisposals++;
    });
  const instanceOwnership = {
    sharedGeometry: skinA.geometry === skinB.geometry,
    sharedMaterial: skinA.material === skinB.material,
    distinctSkeletons: skinA.skeleton !== skinB.skeleton,
    distinctBoneBuffers: skinA.skeleton.boneMatrices.buffer !== skinB.skeleton.boneMatrices.buffer,
    beforeBoneTextureCpuBytes: beforeBoneTextures,
    afterBoneTextureCpuBytes: [
      skinA.skeleton.boneMatrices.byteLength,
      skinB.skeleton.boneMatrices.byteLength,
    ],
    estimatedBoneTextureGpuBytes: [skinA, skinB].map(
      (instance) =>
        instance.skeleton.boneTexture.image.width *
        instance.skeleton.boneTexture.image.height *
        4 *
        4,
    ),
  };
  skinA.skeleton.dispose();
  skinB.skeleton.dispose();
  instanceOwnership.ownedBoneTextureDisposals = ownedBoneTextureDisposals;
  skinnedGeometry.dispose();
  skeleton.dispose();
  const sandbox = [];
  for (const { name, raw } of sources) {
    const bytes = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
    const gltf = await new Promise((resolve, reject) =>
      new GLTFLoader().parse(bytes, '', resolve, reject),
    );
    sandbox.push({ name, downloadBytes: raw.byteLength, ...resources(gltf.scene) });
    new GltfBackend().dispose({ scene: gltf.scene, animations: gltf.animations, meta: {} });
  }
  const timers = [];
  const disposed = [];
  let loads = 0;
  const manifest = {
    version: 1,
    baseUrl: '/',
    assets: {
      parent: {
        type: 'binary',
        url: 'parent.bin',
        hash: 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
        size: 32,
        deps: ['shared'],
      },
      shared: {
        type: 'binary',
        url: 'shared.bin',
        hash: 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
        size: 16,
      },
    },
    groups: {},
    regions: {},
  };
  const loader = new AssetLoader(
    manifest,
    [
      {
        type: 'binary',
        async load(_url, entry, _signal, ctx) {
          loads++;
          return { id: ctx.id, bytes: new ArrayBuffer(entry.size) };
        },
        dispose(asset) {
          disposed.push(asset.id);
        },
      },
    ],
    {
      setTimer(fn, ms) {
        const timer = { fn, ms, active: true };
        timers.push(timer);
        return timer;
      },
      clearTimer(timer) {
        timer.active = false;
      },
    },
  );
  const first = await loader.acquire('parent'),
    second = await loader.acquire('parent');
  first.release();
  const afterFirst = {
    loads,
    disposed: [...disposed],
    peekable: loader.peek('parent') !== undefined,
  };
  second.release();
  const reacquired = await loader.acquire('parent');
  const duringGrace = {
    loads,
    disposed: [...disposed],
    sameAsset: reacquired.asset === first.asset,
  };
  reacquired.release();
  for (let round = 0; round < 3; round++) {
    const batch = timers.splice(0);
    for (const t of batch)
      if (t.active) {
        t.active = false;
        t.fn();
      }
    await Promise.resolve();
  }
  await loader.dispose();
  return {
    version: 1,
    scope:
      'Known typed-buffer estimates and ownership counts only; not measured total heap/GPU residency',
    synthetic,
    allInstances,
    sharedGeometry: cloneA.children[0].geometry === cloneB.children[0].geometry,
    sharedMaterial: cloneA.children[0].material === cloneB.children[0].material,
    disposals,
    sandbox,
    instanceOwnership,
    loaderOwnership: { afterFirst, duringGrace, loads, disposed },
  };
}

import { decomposeMat4, q, v3, type Quat, type Vec3 } from '@conduit/math';
import type { GltfJson, GltfNode } from './glb.ts';
import type { AssetId } from './manifest.ts';

/** Root node name for an asset id: every `.` becomes `_` (`ship.sloop` -> `ship_sloop`). */
export const ROOT_NAME = (id: AssetId): string => id.replace(/\./g, '_');
export const LOD_RE = /^(.+)_LOD([0-2])$/;
export const COLLIDER_RE = /^(.+)_COL_(box|sphere|capsule|convex)(?:\.(\d{3}))?$/;
export const SOCKET_RE = /^SOCKET_([a-z0-9_]+)$/;
export const ANIMATION_NAME_RE = /^[a-z][a-z0-9_]*$/;
export const LOD_DISTANCES: readonly number[] = [0, 50, 150];
export const MAX_LOD_LEVELS = 3;
export const DRACO_EXTENSION = 'KHR_draco_mesh_compression';
/**
 * Meshopt buffer compression (Blender's exporter: Data > Meshopt Compression). Like Draco it needs a
 * decoder that v1's loaders do not set up, so `checkModelNaming` reports it as `draco_required`.
 */
export const MESHOPT_EXTENSIONS: readonly string[] = [
  'EXT_meshopt_compression',
  'KHR_meshopt_compression',
];
export const IDENTITY_EPSILON = 1e-5;

export interface GltfNodeMeta {
  index: number;
  name: string;
  mesh: number | null;
  children: number[];
  /** Local TRS; `matrix` is decomposed when present. Defaults T=0, R=identity, S=1. */
  translation: Vec3;
  rotation: Quat;
  scale: Vec3;
  extras: Record<string, unknown>;
}

export interface LodMeta {
  /** Node name (`<root>_LODn`). */
  name: string;
  node: number;
  /** Metres at which this level becomes active. */
  distance: number;
}

/**
 * Collider primitives from `<root>_COL_*` node TRS (docs/assets.md §5.2). `convex` vertex extraction
 * needs the BIN chunk and is deferred; `node` lets a game read the accessor itself.
 */
export type ColliderMeta =
  | { kind: 'box'; name: string; node: number; halfExtents: Vec3; position: Vec3; rotation: Quat }
  | { kind: 'sphere'; name: string; node: number; radius: number; position: Vec3 }
  | {
      kind: 'capsule';
      name: string;
      node: number;
      radius: number;
      height: number;
      position: Vec3;
      rotation: Quat;
    }
  | { kind: 'convex'; name: string; node: number; position: Vec3; rotation: Quat; scale: Vec3 };

export interface SocketMeta {
  /** Socket name without the `SOCKET_` prefix. */
  name: string;
  node: number;
  /** Root-relative (the root's own transform excluded). */
  position: Vec3;
  rotation: Quat;
}

export interface ModelMeta {
  id: AssetId;
  /** `ROOT_NAME(id)`. */
  root: string;
  /** Index into `nodes`; `null` when the default scene has no top-level node named `root`. */
  rootNode: number | null;
  nodes: GltfNodeMeta[];
  scenes: { name: string; nodes: number[] }[];
  animations: string[];
  /** Sorted by level; empty when the root has no `_LOD` children. */
  lods: LodMeta[];
  colliders: ColliderMeta[];
  sockets: SocketMeta[];
  /** Root node extras. */
  extras: Record<string, unknown>;
}

type ColliderKind = ColliderMeta['kind'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** `arr[i]` when `arr` is an array holding a finite number there, else `fallback`. */
function num(arr: unknown, i: number, fallback: number): number {
  const value: unknown = Array.isArray(arr) ? arr[i] : undefined;
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function toNodeMeta(node: GltfNode | undefined, index: number): GltfNodeMeta {
  const n: GltfNode = isRecord(node) ? node : {};
  const translation = v3.create();
  const rotation = q.identity();
  const scale = v3.create(1, 1, 1);
  if (Array.isArray(n.matrix) && n.matrix.length === 16) {
    decomposeMat4(n.matrix, translation, rotation, scale);
  } else {
    v3.set(
      translation,
      num(n.translation, 0, 0),
      num(n.translation, 1, 0),
      num(n.translation, 2, 0),
    );
    q.set(
      rotation,
      num(n.rotation, 0, 0),
      num(n.rotation, 1, 0),
      num(n.rotation, 2, 0),
      num(n.rotation, 3, 1),
    );
    v3.set(scale, num(n.scale, 0, 1), num(n.scale, 1, 1), num(n.scale, 2, 1));
  }
  return {
    index,
    name: typeof n.name === 'string' ? n.name : '',
    mesh: isIndex(n.mesh) ? n.mesh : null,
    children: Array.isArray(n.children) ? n.children.filter(isIndex) : [],
    translation,
    rotation,
    scale,
    extras: isRecord(n.extras) ? { ...n.extras } : {},
  };
}

function toCollider(kind: ColliderKind, node: GltfNodeMeta): ColliderMeta {
  const { name, index, translation: t, rotation: r, scale: s } = node;
  switch (kind) {
    case 'box':
      return {
        kind,
        name,
        node: index,
        halfExtents: v3.scale(s, 0.5),
        position: v3.copy(t),
        rotation: q.copy(r),
      };
    case 'sphere':
      return { kind, name, node: index, radius: Math.max(s.x, s.y, s.z), position: v3.copy(t) };
    case 'capsule':
      return {
        kind,
        name,
        node: index,
        radius: s.x,
        height: s.y,
        position: v3.copy(t),
        rotation: q.copy(r),
      };
    case 'convex':
      return {
        kind,
        name,
        node: index,
        position: v3.copy(t),
        rotation: q.copy(r),
        scale: v3.copy(s),
      };
  }
}

interface Frame {
  position: Vec3;
  rotation: Quat;
  scale: Vec3;
}

/** Sockets below `rootNode` in DFS pre-order, with transforms composed from the root (exclusive). */
function collectSockets(nodes: readonly GltfNodeMeta[], rootNode: number): SocketMeta[] {
  const sockets: SocketMeta[] = [];
  const visited = new Set<number>([rootNode]);
  const identity: Frame = {
    position: v3.create(),
    rotation: q.identity(),
    scale: v3.create(1, 1, 1),
  };
  const stack: { index: number; parent: Frame }[] = [];
  const pushChildren = (index: number, parent: Frame): void => {
    const children = nodes[index]?.children ?? [];
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i];
      if (child !== undefined) stack.push({ index: child, parent });
    }
  };
  pushChildren(rootNode, identity);
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    const node = nodes[item.index];
    if (node === undefined || visited.has(item.index)) continue;
    visited.add(item.index);
    const { parent } = item;
    const scaled = v3.create(
      parent.scale.x * node.translation.x,
      parent.scale.y * node.translation.y,
      parent.scale.z * node.translation.z,
    );
    const frame: Frame = {
      position: v3.add(parent.position, q.rotateVec3(parent.rotation, scaled)),
      rotation: q.multiply(parent.rotation, node.rotation),
      scale: v3.create(
        parent.scale.x * node.scale.x,
        parent.scale.y * node.scale.y,
        parent.scale.z * node.scale.z,
      ),
    };
    const match = SOCKET_RE.exec(node.name);
    if (match?.[1] !== undefined) {
      sockets.push({
        name: match[1],
        node: item.index,
        position: frame.position,
        rotation: frame.rotation,
      });
    }
    pushChildren(item.index, frame);
  }
  return sockets;
}

/**
 * Derives LODs, colliders, sockets and animation names from glTF JSON using the naming conventions
 * of docs/assets.md §5. Never throws on malformed data: missing pieces come back empty and
 * `checkModelNaming` reports them. Shared by `GltfMetaBackend` (server) and `GltfBackend` (render).
 */
export function deriveModelMeta(json: GltfJson, id: AssetId): ModelMeta {
  const nodes = (Array.isArray(json.nodes) ? json.nodes : []).map(toNodeMeta);
  const scenes = (Array.isArray(json.scenes) ? json.scenes : []).map((s) => ({
    name: typeof s?.name === 'string' ? s.name : '',
    nodes: Array.isArray(s?.nodes) ? s.nodes.filter(isIndex) : [],
  }));
  const animations = (Array.isArray(json.animations) ? json.animations : []).map((a) =>
    typeof a?.name === 'string' ? a.name : '',
  );
  const root = ROOT_NAME(id);
  const scene = scenes[json.scene ?? 0];
  const rootNode = scene?.nodes.find((i) => nodes[i]?.name === root) ?? null;
  const meta: ModelMeta = {
    id,
    root,
    rootNode,
    nodes,
    scenes,
    animations,
    lods: [],
    colliders: [],
    sockets: [],
    extras: {},
  };
  const rootMeta = rootNode === null ? undefined : nodes[rootNode];
  if (rootNode === null || rootMeta === undefined) return meta;

  const lods: (LodMeta & { level: number })[] = [];
  for (const child of rootMeta.children) {
    const node = nodes[child];
    if (node === undefined) continue;
    const lod = LOD_RE.exec(node.name);
    if (lod !== null && lod[1] === root) {
      const level = Number(lod[2]);
      const extra = node.extras.lodDistance;
      const distance = typeof extra === 'number' ? extra : (LOD_DISTANCES[level] ?? 0);
      lods.push({ level, name: node.name, node: child, distance });
      continue;
    }
    const collider = COLLIDER_RE.exec(node.name);
    if (collider !== null && collider[1] === root) {
      meta.colliders.push(toCollider(collider[2] as ColliderKind, node));
    }
  }
  lods.sort((a, b) => a.level - b.level);
  meta.lods = lods.map(({ name, node, distance }) => ({ name, node, distance }));
  meta.sockets = collectSockets(nodes, rootNode);
  meta.extras = rootMeta.extras;
  return meta;
}

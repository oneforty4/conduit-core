import type { Quat, Vec3 } from '@conduit/math';
import type { GltfJson } from './glb.ts';
import type { AssetId } from './manifest.ts';
import {
  ANIMATION_NAME_RE,
  COLLIDER_RE,
  DRACO_EXTENSION,
  IDENTITY_EPSILON,
  LOD_RE,
  MAX_LOD_LEVELS,
  MESHOPT_EXTENSIONS,
  ROOT_NAME,
  SOCKET_RE,
  type GltfNodeMeta,
  type ModelMeta,
} from './model-meta.ts';

export type NamingErrorCode =
  | 'root_missing'
  | 'multiple_roots'
  | 'root_not_top_level'
  | 'root_transform'
  | 'lod_order'
  | 'lod_distance'
  | 'lod_parent'
  | 'collider_shape'
  | 'collider_parent'
  | 'collider_has_children'
  | 'collider_scale'
  | 'socket_name'
  | 'socket_has_mesh'
  | 'animation_name'
  | 'animation_duplicate'
  | 'draco_required'
  | 'external_uri'
  | 'unapplied_transform';

export interface NamingError {
  code: NamingErrorCode;
  /** Offending node name, when the error is about one node. */
  node?: string;
  message: string;
}

/** Any `_LOD<digits>` suffix, so levels above 2 and malformed levels are reported too. */
const ANY_LOD_RE = /^(.+)_LOD(\d+)$/;

const near = (a: number, b: number): boolean => Math.abs(a - b) <= IDENTITY_EPSILON;
const isZero = (v: Vec3): boolean => near(v.x, 0) && near(v.y, 0) && near(v.z, 0);
const isUnit = (v: Vec3): boolean => near(v.x, 1) && near(v.y, 1) && near(v.z, 1);
const isIdentityRotation = (r: Quat): boolean =>
  near(r.x, 0) && near(r.y, 0) && near(r.z, 0) && near(Math.abs(r.w), 1);

function uriList(list: unknown): unknown[] {
  return Array.isArray(list)
    ? list.map((item: unknown) => (item as { uri?: unknown } | null)?.uri)
    : [];
}

/**
 * Checks glTF JSON against the Blender/glTF conventions of docs/assets.md §5 and returns every
 * violation (`[]` when clean). `meta` must be `deriveModelMeta(json, id)`. "Scene 0" is the default
 * scene (`json.scene ?? 0`). Checks relative to the root (LOD and collider placement, LOD distances)
 * are skipped when the root is missing, which is already reported.
 */
export function checkModelNaming(json: GltfJson, meta: ModelMeta, id: AssetId): NamingError[] {
  const errors: NamingError[] = [];
  const add = (code: NamingErrorCode, message: string, node?: string): void => {
    errors.push(node === undefined ? { code, message } : { code, node, message });
  };
  const root = ROOT_NAME(id);
  const { nodes } = meta;
  const sceneIndex = json.scene ?? 0;
  const topLevel = meta.scenes[sceneIndex]?.nodes ?? [];
  const rootMeta: GltfNodeMeta | undefined =
    meta.rootNode === null ? undefined : nodes[meta.rootNode];
  const rootChildren = new Set(rootMeta?.children ?? []);

  // Root.
  if (rootMeta === undefined) {
    if (nodes.some((n) => n.name === root)) {
      add(
        'root_not_top_level',
        `node '${root}' is not a top-level node of scene ${sceneIndex}`,
        root,
      );
    } else {
      add(
        'root_missing',
        `no node named '${root}' (the asset id with '.' replaced by '_') in scene ${sceneIndex}`,
      );
    }
  }
  if (topLevel.length > 1) {
    const names = topLevel.map((i) => `'${nodes[i]?.name ?? i}'`).join(', ');
    add(
      'multiple_roots',
      `scene ${sceneIndex} has ${topLevel.length} top-level nodes (${names}); only '${root}' may be top-level`,
    );
  }
  if (rootMeta !== undefined) {
    const { translation, rotation, scale } = rootMeta;
    if (!isZero(translation) || !isIdentityRotation(rotation) || !isUnit(scale)) {
      add(
        'root_transform',
        `root '${root}' must sit at the origin with identity rotation and unit scale`,
        root,
      );
    }
  }

  // LODs.
  const levels = new Set<number>();
  for (const n of nodes) {
    const any = ANY_LOD_RE.exec(n.name);
    if (any === null || rootMeta === undefined) continue;
    const level = LOD_RE.exec(n.name);
    if (level === null) {
      add('lod_order', `'${n.name}': LOD levels run from 0 to ${MAX_LOD_LEVELS - 1}`, n.name);
    } else if (level[1] !== root || !rootChildren.has(n.index)) {
      add(
        'lod_parent',
        `'${n.name}' must be a direct child of '${root}' named '${root}_LOD<n>'`,
        n.name,
      );
    } else if (levels.has(Number(level[2]))) {
      add('lod_order', `'${n.name}' repeats LOD level ${level[2]}`, n.name);
    } else {
      levels.add(Number(level[2]));
    }
  }
  const sorted = [...levels].sort((a, b) => a - b);
  if (sorted.some((level, i) => level !== i)) {
    add('lod_order', `LOD levels ${sorted.join(', ')} of '${root}' are not contiguous from 0`);
  }
  let previousName = '';
  let previousDistance = Number.NEGATIVE_INFINITY;
  for (const lod of meta.lods) {
    if (lod.name === previousName) continue; // a repeated level, reported as lod_order
    const extras = nodes[lod.node]?.extras ?? {};
    if (Object.hasOwn(extras, 'lodDistance')) {
      const d = extras.lodDistance;
      if (typeof d !== 'number' || !Number.isFinite(d) || d < 0) {
        add(
          'lod_distance',
          `'${lod.name}': lodDistance must be a finite number >= 0, got ${JSON.stringify(d)}`,
          lod.name,
        );
        continue;
      }
    }
    if (!(lod.distance > previousDistance)) {
      add(
        'lod_distance',
        `'${lod.name}': distance ${lod.distance} must be greater than ${previousName}'s ${previousDistance}`,
        lod.name,
      );
    }
    previousName = lod.name;
    previousDistance = lod.distance;
  }

  // Colliders.
  for (const n of nodes) {
    if (!n.name.includes('_COL_')) continue;
    const match = COLLIDER_RE.exec(n.name);
    if (match === null) {
      add(
        'collider_shape',
        `'${n.name}': collider shape must be box, sphere, capsule or convex, optionally suffixed .NNN`,
        n.name,
      );
      continue;
    }
    if (rootMeta !== undefined && (match[1] !== root || !rootChildren.has(n.index))) {
      add(
        'collider_parent',
        `'${n.name}' must be a direct child of '${root}' named '${root}_COL_<shape>'`,
        n.name,
      );
    }
    if (n.children.length > 0) {
      add('collider_has_children', `collider '${n.name}' must not have children`, n.name);
    }
    if (n.scale.x <= 0 || n.scale.y <= 0 || n.scale.z <= 0) {
      add('collider_scale', `collider '${n.name}' scale components must be > 0`, n.name);
    }
  }

  // Sockets.
  for (const n of nodes) {
    if (!n.name.startsWith('SOCKET_')) continue;
    if (!SOCKET_RE.test(n.name)) {
      add('socket_name', `'${n.name}': socket names match ${String(SOCKET_RE)}`, n.name);
    } else if (n.mesh !== null) {
      add('socket_has_mesh', `socket '${n.name}' must be an empty (no mesh)`, n.name);
    }
  }

  // Animations.
  const clips = new Set<string>();
  meta.animations.forEach((name, i) => {
    if (!ANIMATION_NAME_RE.test(name)) {
      add(
        'animation_name',
        `animation ${i} name '${name}' must be lowercase snake_case (${String(ANIMATION_NAME_RE)})`,
      );
    }
    if (clips.has(name))
      add('animation_duplicate', `animation name '${name}' is used more than once`);
    clips.add(name);
  });

  // Extensions and external resources.
  const extensions = [
    ...(Array.isArray(json.extensionsRequired) ? json.extensionsRequired : []),
    ...(Array.isArray(json.extensionsUsed) ? json.extensionsUsed : []),
  ];
  // Compressed geometry needs a decoder the loaders do not set up (Draco or meshopt): one error each.
  for (const [extension, option] of [
    [DRACO_EXTENSION, 'Draco Compression'],
    ...MESHOPT_EXTENSIONS.map((ext) => [ext, 'Meshopt Compression'] as const),
  ] as const) {
    if (extensions.includes(extension)) {
      add('draco_required', `${extension} is not supported in v1; export with ${option} off`);
    }
  }
  for (const [kind, list] of [
    ['buffers', json.buffers],
    ['images', json.images],
  ] as const) {
    uriList(list).forEach((uri, i) => {
      if (typeof uri === 'string' && !uri.startsWith('data:')) {
        add('external_uri', `${kind}[${i}].uri '${uri}' is external; export a self-contained .glb`);
      }
    });
  }

  // Transforms left unapplied on visual meshes.
  for (const n of nodes) {
    if (n.mesh === null || n.index === meta.rootNode) continue;
    if (n.name.includes('_COL_') || n.name.startsWith('SOCKET_')) continue;
    if (!isIdentityRotation(n.rotation) || !isUnit(n.scale)) {
      add(
        'unapplied_transform',
        `mesh node '${n.name}' has non-identity rotation or non-unit scale; apply transforms before export`,
        n.name,
      );
    }
  }
  return errors;
}

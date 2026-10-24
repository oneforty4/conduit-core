import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DRACO_EXTENSION,
  MESHOPT_EXTENSIONS,
  checkModelNaming,
  deriveModelMeta,
  parseGlb,
  type GltfJson,
  type GltfNode,
  type NamingError,
  type NamingErrorCode,
} from '../src/index.ts';
import { SHIP_SLOOP_GLB_PATH, SHIP_SLOOP_ID } from './fixtures/make-glb.ts';

const fixture = parseGlb(readFileSync(SHIP_SLOOP_GLB_PATH), { jsonOnly: true }).json;
const S = Math.SQRT1_2;

// Node indices in the fixture (see test/fixtures/make-glb.ts).
const ROOT = 0;
const LOD1 = 2;
const LOD2 = 3;
const COL_BOX = 4;
const COL_SPHERE = 5;
const DECK = 8;
const HELM = 11;

function check(json: GltfJson, id = SHIP_SLOOP_ID): NamingError[] {
  return checkModelNaming(json, deriveModelMeta(json, id), id);
}

function node(json: GltfJson, index: number): GltfNode {
  const found = json.nodes?.[index];
  if (found === undefined) throw new Error(`fixture has no node ${index}`);
  return found;
}

/** Moves `child` from the root's children to `parent`'s. */
function reparent(json: GltfJson, child: number, parent: number): void {
  const root = node(json, ROOT);
  root.children = (root.children ?? []).filter((c) => c !== child);
  const target = node(json, parent);
  target.children = [...(target.children ?? []), child];
}

/** One mutation of the fixture JSON per code; each must produce exactly that code. */
const MUTATIONS: Record<NamingErrorCode, (json: GltfJson) => void> = {
  root_missing: (json) => {
    node(json, ROOT).name = 'ship';
  },
  multiple_roots: (json) => {
    json.nodes?.push({ name: 'sun' });
    json.scenes?.[0]?.nodes?.push(12);
  },
  root_not_top_level: (json) => {
    json.nodes?.push({ name: 'wrapper', children: [ROOT] });
    const scene = json.scenes?.[0];
    if (scene) scene.nodes = [12];
  },
  root_transform: (json) => {
    node(json, ROOT).translation = [0, 1, 0];
  },
  lod_order: (json) => {
    node(json, LOD1).name = 'hull_detail';
  },
  lod_distance: (json) => {
    node(json, LOD2).extras = { lodDistance: 40 };
  },
  lod_parent: (json) => reparent(json, LOD2, DECK),
  collider_shape: (json) => {
    node(json, COL_BOX).name = 'ship_sloop_COL_cylinder';
  },
  collider_parent: (json) => reparent(json, COL_SPHERE, DECK),
  collider_has_children: (json) => reparent(json, HELM, COL_BOX),
  collider_scale: (json) => {
    node(json, COL_SPHERE).scale = [0.5, 0, 1];
  },
  socket_name: (json) => {
    node(json, HELM).name = 'SOCKET_Helm';
  },
  socket_has_mesh: (json) => {
    node(json, HELM).mesh = 0;
  },
  animation_name: (json) => {
    const clip = json.animations?.[0];
    if (clip) clip.name = 'Idle';
  },
  animation_duplicate: (json) => {
    const clip = json.animations?.[1];
    if (clip) clip.name = 'idle';
  },
  draco_required: (json) => {
    json.extensionsUsed = [DRACO_EXTENSION];
    json.extensionsRequired = [DRACO_EXTENSION];
  },
  external_uri: (json) => {
    const buffer = json.buffers?.[0];
    if (buffer) buffer.uri = 'ship_sloop.bin';
  },
  unapplied_transform: (json) => {
    node(json, 1).scale = [2, 2, 2];
  },
};

describe('checkModelNaming', () => {
  it('passes the unmodified fixture', () => {
    expect(check(fixture)).toEqual([]);
  });

  for (const [code, mutate] of Object.entries(MUTATIONS) as [
    NamingErrorCode,
    (j: GltfJson) => void,
  ][]) {
    it(`reports ${code}`, () => {
      const json = structuredClone(fixture);
      mutate(json);
      const errors = check(json);
      expect(errors.map((e) => e.code)).toEqual([code]);
      expect(errors[0]?.message.length).toBeGreaterThan(0);
    });
  }

  it('reports meshopt compression as draco_required too, one error per extension', () => {
    expect(MESHOPT_EXTENSIONS).toEqual(['EXT_meshopt_compression', 'KHR_meshopt_compression']);
    const json = structuredClone(fixture);
    json.extensionsUsed = ['EXT_meshopt_compression', 'KHR_materials_emissive_strength'];
    json.extensionsRequired = ['EXT_meshopt_compression'];
    expect(check(json)).toEqual([
      {
        code: 'draco_required',
        message:
          'EXT_meshopt_compression is not supported in v1; export with Meshopt Compression off',
      },
    ]);
    json.extensionsUsed = [DRACO_EXTENSION, 'KHR_meshopt_compression'];
    expect(check(json).map((e) => e.message)).toEqual([
      `${DRACO_EXTENSION} is not supported in v1; export with Draco Compression off`,
      'EXT_meshopt_compression is not supported in v1; export with Meshopt Compression off',
      'KHR_meshopt_compression is not supported in v1; export with Meshopt Compression off',
    ]);
  });

  it('names the offending node when the error is about one node', () => {
    const json = structuredClone(fixture);
    MUTATIONS.collider_scale(json);
    expect(check(json)).toEqual([
      {
        code: 'collider_scale',
        node: 'ship_sloop_COL_sphere',
        message: "collider 'ship_sloop_COL_sphere' scale components must be > 0",
      },
    ]);
  });

  it('checks the asset id: the same file under another id has no root', () => {
    expect(check(fixture, 'boat').map((e) => e.code)).toEqual(['root_missing']);
  });

  it('reports LOD levels above 2, repeated levels and invalid lodDistance values', () => {
    const json = structuredClone(fixture);
    node(json, LOD1).name = 'ship_sloop_LOD3';
    json.nodes?.push({ name: 'ship_sloop_LOD0', mesh: 0 });
    node(json, ROOT).children?.push(12);
    node(json, LOD2).extras = { lodDistance: -5 };
    expect(check(json).map((e) => `${e.code} ${e.node ?? ''}`)).toEqual([
      'lod_order ship_sloop_LOD3',
      'lod_order ship_sloop_LOD0',
      'lod_order ',
      'lod_distance ship_sloop_LOD2',
    ]);
  });

  it('flags LOD and collider nodes named for another root', () => {
    const json = structuredClone(fixture);
    node(json, LOD2).name = 'boat_LOD2';
    node(json, COL_BOX).name = 'boat_COL_box';
    expect(check(json).map((e) => `${e.code} ${e.node ?? ''}`)).toEqual([
      'lod_parent boat_LOD2',
      'collider_parent boat_COL_box',
    ]);
  });

  it('accepts data: uris, sockets at any depth and rotated or scaled empties', () => {
    const json = structuredClone(fixture);
    const buffer = json.buffers?.[0];
    if (buffer) buffer.uri = 'data:application/octet-stream;base64,AAAA';
    json.images = [{ uri: 'data:image/png;base64,AAAA' }];
    node(json, DECK).rotation = [S, 0, 0, S];
    expect(check(json)).toEqual([]);
    json.images = [{ uri: 'textures/hull.png' }];
    expect(check(json).map((e) => e.code)).toEqual(['external_uri']);
  });
});

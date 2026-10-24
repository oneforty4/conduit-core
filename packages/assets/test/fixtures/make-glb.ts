/**
 * Generates `ship_sloop.glb`, the model fixture for the glb-meta, naming and check tests
 * (docs/assets.md §6) and for render's `GltfBackend` test. Output is deterministic, so the committed
 * file can always be reproduced:
 *
 *   node packages/assets/test/fixtures/make-glb.ts        (Node >= 22.18; or `pnpm exec tsx ...`)
 *
 * Asset id `ship.sloop`, root `ship_sloop` (identity TRS, extras `{ displayName, crew }`):
 *   ship_sloop_LOD0, _LOD1, _LOD2 (extras.lodDistance = 200)       meshes sharing material `hull`
 *   ship_sloop_COL_box / _COL_sphere / _COL_capsule / _COL_convex.001 meshes sharing material `collider`
 *   deck (empty; T (0,1,0.5), R 90deg about +Y, S 2) -> SOCKET_cannon_l, SOCKET_cannon_r
 *   SOCKET_helm
 * Animations `idle` (deck translation) and `sail` (deck rotation). Every mesh has its own accessors,
 * so a glTF loader shares no geometry between nodes; no textures (jsdom cannot decode images).
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GLB_CHUNK_BIN, GLB_CHUNK_JSON, GLB_MAGIC, GLB_VERSION } from '../../src/glb.ts';

export const SHIP_SLOOP_ID = 'ship.sloop';
/** Absolute path of the committed fixture. */
export const SHIP_SLOOP_GLB_PATH = fileURLToPath(new URL('./ship_sloop.glb', import.meta.url));

const FLOAT = 5126;
const UNSIGNED_SHORT = 5123;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;
const S = Math.SQRT1_2;

type JsonObject = Record<string, unknown>;
type AccessorType = 'SCALAR' | 'VEC3' | 'VEC4';
const COMPONENTS: Record<AccessorType, number> = { SCALAR: 1, VEC3: 3, VEC4: 4 };

const align4 = (n: number): number => (n + 3) & ~3;

/** Packs a GLB: JSON chunk padded with spaces, optional BIN chunk padded with zeros. */
export function encodeGlb(json: unknown, bin: Uint8Array | null = null): Uint8Array {
  const text = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = align4(text.length);
  const binLength = bin === null ? 0 : align4(bin.length);
  const total = 12 + 8 + jsonLength + (bin === null ? 0 : 8 + binLength);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, GLB_MAGIC, true);
  dv.setUint32(4, GLB_VERSION, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonLength, true);
  dv.setUint32(16, GLB_CHUNK_JSON, true);
  out.set(text, 20);
  out.fill(0x20, 20 + text.length, 20 + jsonLength);
  if (bin !== null) {
    const at = 20 + jsonLength;
    dv.setUint32(at, binLength, true);
    dv.setUint32(at + 4, GLB_CHUNK_BIN, true);
    out.set(bin, at + 8);
  }
  return out;
}

/** Accumulates little-endian buffer views and accessors for one glTF buffer. */
class BufferBuilder {
  readonly bufferViews: JsonObject[] = [];
  readonly accessors: JsonObject[] = [];
  private readonly parts: Uint8Array[] = [];
  private length = 0;

  private view(bytes: Uint8Array, target?: number): number {
    const padding = align4(this.length) - this.length;
    if (padding > 0) {
      this.parts.push(new Uint8Array(padding));
      this.length += padding;
    }
    const view: JsonObject = { buffer: 0, byteOffset: this.length, byteLength: bytes.length };
    if (target !== undefined) view.target = target;
    this.parts.push(bytes);
    this.length += bytes.length;
    this.bufferViews.push(view);
    return this.bufferViews.length - 1;
  }

  floats(
    values: readonly number[],
    type: AccessorType,
    opts: { target?: number; bounds?: boolean } = {},
  ): number {
    const size = COMPONENTS[type];
    const bytes = new Uint8Array(values.length * 4);
    const dv = new DataView(bytes.buffer);
    values.forEach((v, i) => dv.setFloat32(i * 4, v, true));
    const accessor: JsonObject = {
      bufferView: this.view(bytes, opts.target),
      componentType: FLOAT,
      count: values.length / size,
      type,
    };
    if (opts.bounds === true) {
      const min: number[] = [];
      const max: number[] = [];
      for (let c = 0; c < size; c++) {
        const column = values.filter((_, i) => i % size === c).map((v) => Math.fround(v));
        min.push(Math.min(...column));
        max.push(Math.max(...column));
      }
      accessor.min = min;
      accessor.max = max;
    }
    this.accessors.push(accessor);
    return this.accessors.length - 1;
  }

  indices(values: readonly number[]): number {
    const bytes = new Uint8Array(values.length * 2);
    const dv = new DataView(bytes.buffer);
    values.forEach((v, i) => dv.setUint16(i * 2, v, true));
    this.accessors.push({
      bufferView: this.view(bytes, ELEMENT_ARRAY_BUFFER),
      componentType: UNSIGNED_SHORT,
      count: values.length,
      type: 'SCALAR',
    });
    return this.accessors.length - 1;
  }

  bytes(): Uint8Array {
    const out = new Uint8Array(align4(this.length));
    let at = 0;
    for (const part of this.parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }
}

interface Shape {
  positions: number[];
  indices: number[];
}

function box(hx: number, hy: number, hz: number): Shape {
  return {
    positions: [
      -hx,
      -hy,
      -hz,
      hx,
      -hy,
      -hz,
      hx,
      hy,
      -hz,
      -hx,
      hy,
      -hz,
      -hx,
      -hy,
      hz,
      hx,
      -hy,
      hz,
      hx,
      hy,
      hz,
      -hx,
      hy,
      hz,
    ],
    indices: [
      0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 1, 2, 6, 1, 6, 5, 0,
      4, 7, 0, 7, 3,
    ],
  };
}

/** Hull with a ridge along z: a cheaper LOD1 silhouette. */
function wedge(hx: number, hy: number, hz: number): Shape {
  return {
    positions: [-hx, -hy, -hz, hx, -hy, -hz, hx, -hy, hz, -hx, -hy, hz, 0, hy, -hz, 0, hy, hz],
    indices: [0, 1, 2, 0, 2, 3, 0, 3, 5, 0, 5, 4, 1, 4, 5, 1, 5, 2, 0, 4, 1, 3, 2, 5],
  };
}

function octahedron(rx: number, ry: number, rz: number): Shape {
  return {
    positions: [rx, 0, 0, -rx, 0, 0, 0, ry, 0, 0, -ry, 0, 0, 0, rz, 0, 0, -rz],
    indices: [0, 2, 4, 4, 2, 1, 1, 2, 5, 5, 2, 0, 4, 3, 0, 1, 3, 4, 5, 3, 1, 0, 3, 5],
  };
}

function tetrahedron(r: number): Shape {
  return {
    positions: [0, r, 0, -r, -r, r, r, -r, r, 0, -r, -r],
    indices: [0, 1, 2, 0, 2, 3, 0, 3, 1, 1, 3, 2],
  };
}

/** The glTF JSON and BIN chunk of the fixture. */
export function shipSloopGltf(): { json: JsonObject; bin: Uint8Array } {
  const buffer = new BufferBuilder();
  const meshes: JsonObject[] = [];
  const mesh = (name: string, shape: Shape, material: number): number => {
    const position = buffer.floats(shape.positions, 'VEC3', { target: ARRAY_BUFFER, bounds: true });
    const indices = buffer.indices(shape.indices);
    meshes.push({ name, primitives: [{ attributes: { POSITION: position }, indices, material }] });
    return meshes.length - 1;
  };
  const HULL = 0;
  const COLLIDER = 1;
  const lod0 = mesh('hull_lod0', box(1, 0.5, 3), HULL);
  const lod1 = mesh('hull_lod1', wedge(1, 0.5, 3), HULL);
  const lod2 = mesh('hull_lod2', tetrahedron(1), HULL);
  const colBox = mesh('col_box', box(0.5, 0.5, 0.5), COLLIDER);
  const colSphere = mesh('col_sphere', octahedron(1, 1, 1), COLLIDER);
  const colCapsule = mesh('col_capsule', octahedron(1, 0.5, 1), COLLIDER);
  const colConvex = mesh('col_convex', tetrahedron(1), COLLIDER);

  const DECK = 8;
  const q100y = [0, Math.sin((50 * Math.PI) / 180), 0, Math.cos((50 * Math.PI) / 180)];
  const idleTimes = buffer.floats([0, 1, 2], 'SCALAR', { bounds: true });
  const idleValues = buffer.floats([0, 1, 0.5, 0, 1.125, 0.5, 0, 1, 0.5], 'VEC3');
  const sailTimes = buffer.floats([0, 1.5, 3], 'SCALAR', { bounds: true });
  const sailValues = buffer.floats([0, S, 0, S, ...q100y, 0, S, 0, S], 'VEC4');
  const bin = buffer.bytes();

  const json: JsonObject = {
    asset: { version: '2.0', generator: 'conduit-core make-glb' },
    scene: 0,
    scenes: [{ name: 'Scene', nodes: [0] }],
    nodes: [
      {
        name: 'ship_sloop',
        children: [1, 2, 3, 4, 5, 6, 7, DECK, 11],
        extras: { displayName: 'Sloop', crew: 4 },
      },
      { name: 'ship_sloop_LOD0', mesh: lod0 },
      { name: 'ship_sloop_LOD1', mesh: lod1 },
      { name: 'ship_sloop_LOD2', mesh: lod2, extras: { lodDistance: 200 } },
      {
        name: 'ship_sloop_COL_box',
        mesh: colBox,
        translation: [0, 0.5, 0],
        rotation: [0, S, 0, S],
        scale: [2, 1, 6],
      },
      {
        name: 'ship_sloop_COL_sphere',
        mesh: colSphere,
        translation: [0, 1, 2.5],
        scale: [0.5, 1.5, 1],
      },
      {
        name: 'ship_sloop_COL_capsule',
        mesh: colCapsule,
        translation: [0, 3, -1],
        rotation: [0, 0, S, S],
        scale: [0.25, 4, 0.25],
      },
      {
        name: 'ship_sloop_COL_convex.001',
        mesh: colConvex,
        translation: [0, 0.25, -2.5],
        scale: [1, 0.5, 1],
      },
      {
        name: 'deck',
        children: [9, 10],
        translation: [0, 1, 0.5],
        rotation: [0, S, 0, S],
        scale: [2, 2, 2],
      },
      { name: 'SOCKET_cannon_l', translation: [0.5, 0, 0], rotation: [S, 0, 0, S] },
      { name: 'SOCKET_cannon_r', translation: [-0.5, 0, 0] },
      { name: 'SOCKET_helm', translation: [0, 1.5, -2.75] },
    ],
    meshes,
    materials: [
      {
        name: 'hull',
        pbrMetallicRoughness: {
          baseColorFactor: [0.5, 0.375, 0.25, 1],
          metallicFactor: 0,
          roughnessFactor: 0.875,
        },
      },
      {
        name: 'collider',
        pbrMetallicRoughness: {
          baseColorFactor: [1, 0, 1, 1],
          metallicFactor: 0,
          roughnessFactor: 1,
        },
      },
    ],
    animations: [
      {
        name: 'idle',
        channels: [{ sampler: 0, target: { node: DECK, path: 'translation' } }],
        samplers: [{ input: idleTimes, output: idleValues, interpolation: 'LINEAR' }],
      },
      {
        name: 'sail',
        channels: [{ sampler: 0, target: { node: DECK, path: 'rotation' } }],
        samplers: [{ input: sailTimes, output: sailValues, interpolation: 'LINEAR' }],
      },
    ],
    accessors: buffer.accessors,
    bufferViews: buffer.bufferViews,
    buffers: [{ byteLength: bin.length }],
  };
  return { json, bin };
}

/** The fixture's bytes, identical to the committed `ship_sloop.glb`. */
export function makeShipSloopGlb(): Uint8Array {
  const { json, bin } = shipSloopGltf();
  return encodeGlb(json, bin);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const bytes = makeShipSloopGlb();
  writeFileSync(SHIP_SLOOP_GLB_PATH, bytes);
  console.log(`wrote ${SHIP_SLOOP_GLB_PATH} (${bytes.length} bytes)`);
}

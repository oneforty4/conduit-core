import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Quat } from '@conduit/math';
import { describe, expect, it, vi } from 'vitest';
import {
  AssetLoader,
  GLB_CHUNK_BIN,
  GLB_CHUNK_JSON,
  GLB_HEADER_BYTES,
  GLB_MAGIC,
  GLB_VERSION,
  GlbParseError,
  GltfMetaBackend,
  LOD_DISTANCES,
  ROOT_NAME,
  deriveModelMeta,
  parseGlb,
  sriFromDigest,
  validateManifest,
  type GlbErrorCode,
  type GltfJson,
  type Manifest,
  type ModelMeta,
} from '../src/index.ts';
import {
  SHIP_SLOOP_GLB_PATH,
  SHIP_SLOOP_ID,
  encodeGlb,
  makeShipSloopGlb,
  shipSloopGltf,
} from './fixtures/make-glb.ts';
import { ManualTimers, flush, recordEvents } from './loader-harness.ts';

const fixture = new Uint8Array(readFileSync(SHIP_SLOOP_GLB_PATH));
/** The sandbox's Blender export (docs/assets.md §5.1): `vehicle_COL_box`, sockets `camera` and `horn`. */
const VEHICLE_GLB_PATH = path.resolve(
  import.meta.dirname,
  '../../../examples/sandbox/assets/vehicle.glb',
);
const S = Math.SQRT1_2;

/** A copy of the fixture bytes with `edit` applied through a DataView. */
function corrupt(
  edit: (dv: DataView, bytes: Uint8Array) => void,
  length = fixture.length,
): Uint8Array {
  const bytes = fixture.slice(0, length);
  edit(new DataView(bytes.buffer), bytes);
  return bytes;
}

function parseError(input: Uint8Array): GlbErrorCode | 'none' {
  try {
    parseGlb(input);
    return 'none';
  } catch (error) {
    expect(error).toBeInstanceOf(GlbParseError);
    return (error as GlbParseError).code;
  }
}

const json = (): GltfJson => structuredClone(parseGlb(fixture).json);

function expectQuat(actual: Quat, expected: [number, number, number, number]): void {
  const [x, y, z, w] = expected;
  // q and -q are the same rotation.
  const sign = Math.sign(actual.w * w + actual.x * x + actual.y * y + actual.z * z) || 1;
  expect(actual.x * sign).toBeCloseTo(x, 6);
  expect(actual.y * sign).toBeCloseTo(y, 6);
  expect(actual.z * sign).toBeCloseTo(z, 6);
  expect(actual.w * sign).toBeCloseTo(w, 6);
}

describe('ship_sloop.glb fixture', () => {
  it('is reproducible from make-glb.ts', () => {
    expect(Buffer.from(makeShipSloopGlb()).equals(Buffer.from(fixture))).toBe(true);
  });
});

describe('parseGlb', () => {
  it('reads the header, the JSON chunk and a copy of the BIN chunk', () => {
    const glb = parseGlb(fixture);
    expect(glb.byteLength).toBe(fixture.length);
    expect(glb.json.asset.version).toBe('2.0');
    expect(glb.json.nodes?.[0]?.name).toBe('ship_sloop');
    expect(glb.bin).toBeInstanceOf(ArrayBuffer);
    expect(glb.bin?.byteLength).toBe(glb.json.buffers?.[0]?.byteLength);
    const { bin } = shipSloopGltf();
    expect(Buffer.from(glb.bin ?? new ArrayBuffer(0)).equals(Buffer.from(bin))).toBe(true);
    expect([GLB_MAGIC, GLB_VERSION, GLB_CHUNK_JSON, GLB_CHUNK_BIN, GLB_HEADER_BYTES]).toEqual([
      0x46546c67, 2, 0x4e4f534a, 0x004e4942, 12,
    ]);
  });

  it('jsonOnly skips the BIN chunk', () => {
    const glb = parseGlb(fixture, { jsonOnly: true });
    expect(glb.bin).toBeNull();
    expect(glb.json).toEqual(parseGlb(fixture).json);
  });

  it('accepts an ArrayBuffer and a Uint8Array view with an offset', () => {
    const padded = new Uint8Array(fixture.length + 7);
    padded.set(fixture, 5);
    const view = padded.subarray(5, 5 + fixture.length);
    expect(parseGlb(view).json).toEqual(parseGlb(fixture.slice().buffer).json);
    expect(parseGlb(view).bin?.byteLength).toBe(parseGlb(fixture).bin?.byteLength);
  });

  it('throws bad_magic, bad_version, truncated, no_json_chunk and bad_json for corrupted copies', () => {
    expect(parseError(corrupt((dv) => dv.setUint32(0, 0x12345678, true)))).toBe('bad_magic');
    expect(parseError(corrupt((dv) => dv.setUint32(4, 1, true)))).toBe('bad_version');
    expect(parseError(fixture.slice(0, 11))).toBe('truncated');
    expect(parseError(fixture.slice(0, fixture.length - 4))).toBe('truncated');
    expect(
      parseError(corrupt((dv) => dv.setUint32(12, fixture.length, true))), // JSON chunk runs past the end
    ).toBe('truncated');
    expect(parseError(corrupt((dv) => dv.setUint32(16, 0x5458_4554, true)))).toBe('no_json_chunk');
    const headerOnly = new Uint8Array(GLB_HEADER_BYTES);
    const header = new DataView(headerOnly.buffer);
    header.setUint32(0, GLB_MAGIC, true);
    header.setUint32(4, GLB_VERSION, true);
    header.setUint32(8, GLB_HEADER_BYTES, true);
    expect(parseError(headerOnly)).toBe('no_json_chunk');
    expect(parseError(corrupt((_, bytes) => bytes.fill(0x7b, 20, 24)))).toBe('bad_json');
    expect(parseError(encodeGlb([1, 2, 3]))).toBe('bad_json');
  });

  it('tolerates chunk lengths that are not padded to 4 bytes', () => {
    const text = new TextEncoder().encode('{"asset":{"version":"2.0"}}');
    expect(text.length % 4).not.toBe(0);
    const bytes = new Uint8Array(12 + 8 + text.length + 3 + 8 + 4);
    const dv = new DataView(bytes.buffer);
    dv.setUint32(0, GLB_MAGIC, true);
    dv.setUint32(4, GLB_VERSION, true);
    dv.setUint32(12, text.length, true);
    dv.setUint32(16, GLB_CHUNK_JSON, true);
    bytes.set(text, 20);
    const bin = 20 + text.length + ((4 - (text.length % 4)) % 4);
    dv.setUint32(bin, 4, true);
    dv.setUint32(bin + 4, GLB_CHUNK_BIN, true);
    dv.setUint32(bin + 8, 0xdeadbeef, true);
    dv.setUint32(8, bin + 12, true);
    const glb = parseGlb(bytes.subarray(0, bin + 12));
    expect(glb.json.asset.version).toBe('2.0');
    expect(new DataView(glb.bin ?? new ArrayBuffer(4)).getUint32(0, true)).toBe(0xdeadbeef);
  });
});

describe('deriveModelMeta', () => {
  const meta = deriveModelMeta(parseGlb(fixture).json, SHIP_SLOOP_ID);

  it('finds the root, scenes, animations and root extras', () => {
    expect(ROOT_NAME(SHIP_SLOOP_ID)).toBe('ship_sloop');
    expect(meta.id).toBe('ship.sloop');
    expect(meta.root).toBe('ship_sloop');
    expect(meta.rootNode).toBe(0);
    expect(meta.scenes).toEqual([{ name: 'Scene', nodes: [0] }]);
    expect(meta.animations).toEqual(['idle', 'sail']);
    expect(meta.extras).toEqual({ displayName: 'Sloop', crew: 4 });
    expect(meta.nodes).toHaveLength(12);
    expect(meta.nodes[3]).toMatchObject({
      index: 3,
      name: 'ship_sloop_LOD2',
      mesh: 2,
      children: [],
      extras: { lodDistance: 200 },
    });
    expect(meta.nodes[8]?.mesh).toBeNull();
  });

  it('lists 3 LODs by level with default distances, LOD2 overridden by its extra', () => {
    expect(LOD_DISTANCES).toEqual([0, 50, 150]);
    expect(meta.lods).toEqual([
      { name: 'ship_sloop_LOD0', node: 1, distance: 0 },
      { name: 'ship_sloop_LOD1', node: 2, distance: 50 },
      { name: 'ship_sloop_LOD2', node: 3, distance: 200 },
    ]);
  });

  it('derives collider shapes from node TRS', () => {
    const byKind = Object.fromEntries(meta.colliders.map((c) => [c.kind, c]));
    expect(meta.colliders.map((c) => c.name)).toEqual([
      'ship_sloop_COL_box',
      'ship_sloop_COL_sphere',
      'ship_sloop_COL_capsule',
      'ship_sloop_COL_convex.001',
    ]);
    expect(byKind.box).toEqual({
      kind: 'box',
      name: 'ship_sloop_COL_box',
      node: 4,
      halfExtents: { x: 1, y: 0.5, z: 3 },
      position: { x: 0, y: 0.5, z: 0 },
      rotation: { x: 0, y: S, z: 0, w: S },
    });
    expect(byKind.sphere).toEqual({
      kind: 'sphere',
      name: 'ship_sloop_COL_sphere',
      node: 5,
      radius: 1.5,
      position: { x: 0, y: 1, z: 2.5 },
    });
    expect(byKind.capsule).toEqual({
      kind: 'capsule',
      name: 'ship_sloop_COL_capsule',
      node: 6,
      radius: 0.25,
      height: 4,
      position: { x: 0, y: 3, z: -1 },
      rotation: { x: 0, y: 0, z: S, w: S },
    });
    expect(byKind.convex).toEqual({
      kind: 'convex',
      name: 'ship_sloop_COL_convex.001',
      node: 7,
      position: { x: 0, y: 0.25, z: -2.5 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 0.5, z: 1 },
    });
  });

  it('composes socket transforms through the nested empty, in DFS pre-order', () => {
    expect(meta.sockets.map((s) => [s.name, s.node])).toEqual([
      ['cannon_l', 9],
      ['cannon_r', 10],
      ['helm', 11],
    ]);
    const [cannonL, cannonR, helm] = meta.sockets;
    // deck: T (0, 1, 0.5), R 90deg about +Y, S 2. cannon_l: T (0.5, 0, 0), R 90deg about +X.
    // p = (0, 1, 0.5) + rotY90(2 * (0.5, 0, 0)) = (0, 1, 0.5) + (0, 0, -1); r = rotY90 * rotX90.
    expect(cannonL?.position.x).toBeCloseTo(0, 6);
    expect(cannonL?.position.y).toBeCloseTo(1, 6);
    expect(cannonL?.position.z).toBeCloseTo(-0.5, 6);
    expectQuat(cannonL?.rotation ?? { x: 0, y: 0, z: 0, w: 1 }, [0.5, 0.5, -0.5, 0.5]);
    expect(cannonR?.position.x).toBeCloseTo(0, 6);
    expect(cannonR?.position.z).toBeCloseTo(1.5, 6);
    expectQuat(cannonR?.rotation ?? { x: 0, y: 0, z: 0, w: 1 }, [0, S, 0, S]);
    expect(helm).toEqual({
      name: 'helm',
      node: 11,
      position: { x: 0, y: 1.5, z: -2.75 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
    });
  });

  it('decomposes node matrices like TRS', () => {
    const copy = json();
    const deck = copy.nodes?.[8];
    if (deck === undefined) throw new Error('fixture has no deck');
    // Column-major TRS of T (0, 1, 0.5), R 90deg about +Y, S 2.
    deck.matrix = [0, 0, -2, 0, 0, 2, 0, 0, 2, 0, 0, 0, 0, 1, 0.5, 1];
    delete deck.translation;
    delete deck.rotation;
    delete deck.scale;
    const fromMatrix = deriveModelMeta(copy, SHIP_SLOOP_ID);
    meta.sockets.forEach((socket, i) => {
      const other = fromMatrix.sockets[i];
      expect(other?.name).toBe(socket.name);
      for (const axis of ['x', 'y', 'z'] as const) {
        expect(other?.position[axis]).toBeCloseTo(socket.position[axis], 6);
      }
      expectQuat(other?.rotation ?? { x: 0, y: 0, z: 0, w: 1 }, [
        socket.rotation.x,
        socket.rotation.y,
        socket.rotation.z,
        socket.rotation.w,
      ]);
    });
  });

  it('uses default distances without extras and has no LODs without _LOD children', () => {
    const copy = json();
    const lod2 = copy.nodes?.[3];
    if (lod2 !== undefined) delete lod2.extras;
    expect(deriveModelMeta(copy, SHIP_SLOOP_ID).lods.map((l) => l.distance)).toEqual([0, 50, 150]);
    const bare: GltfJson = {
      asset: { version: '2.0' },
      scenes: [{ nodes: [0] }],
      nodes: [{ name: 'crate', mesh: 0 }],
    };
    expect(deriveModelMeta(bare, 'crate')).toMatchObject({
      rootNode: 0,
      lods: [],
      colliders: [],
      sockets: [],
      animations: [],
      extras: {},
    });
  });

  it('returns empty lods, colliders and sockets when the root is missing', () => {
    const boat = deriveModelMeta(parseGlb(fixture).json, 'boat');
    expect(boat.root).toBe('boat');
    expect(boat.rootNode).toBeNull();
    expect(boat).toMatchObject({ lods: [], colliders: [], sockets: [], extras: {} });
    expect(boat.animations).toEqual(['idle', 'sail']);
    expect(deriveModelMeta({ asset: { version: '2.0' } }, 'empty')).toMatchObject({
      rootNode: null,
      nodes: [],
      scenes: [],
      animations: [],
    });
  });
});

describe('GltfMetaBackend on a Node server, through AssetLoader', () => {
  const vehicleBytes = new Uint8Array(readFileSync(VEHICLE_GLB_PATH));
  const vehicleMeta = (): ModelMeta => deriveModelMeta(parseGlb(vehicleBytes).json, 'vehicle');

  /**
   * A valid manifest of `model` assets (id -> file path or bytes, real hashes and sizes) and a Node
   * `fetch` stand-in serving each at `/assets/models/<id>.glb`: files are read with `readFile`, which
   * honours `init.signal` unless `ignoreSignal`; with `gate`, requests wait for it first.
   */
  function serve(
    models: Record<string, string | Uint8Array>,
    opts: { gate?: Promise<void>; ignoreSignal?: boolean } = {},
  ) {
    const manifest: Manifest = {
      version: 1,
      baseUrl: '/assets/',
      assets: {},
      groups: {},
      regions: {},
    };
    const routes = new Map<string, string | Uint8Array>();
    for (const [id, source] of Object.entries(models)) {
      const bytes = typeof source === 'string' ? readFileSync(source) : source;
      manifest.assets[id] = {
        type: 'model',
        url: `models/${id}.glb`,
        hash: sriFromDigest(createHash('sha256').update(bytes).digest()),
        size: bytes.length,
      };
      routes.set(`/assets/models/${id}.glb`, source);
    }
    expect(validateManifest(manifest)).toEqual([]);
    const fetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const source = routes.get(String(input));
        if (source === undefined) return new Response('not found', { status: 404 });
        await opts.gate;
        const signal = opts.ignoreSignal === true ? undefined : (init?.signal ?? undefined);
        return new Response(
          typeof source === 'string' ? await readFile(source, { signal }) : source,
        );
      },
    );
    return { manifest, fetch };
  }

  it('loads ModelMeta for ship_sloop.glb and the sandbox vehicle.glb, hashes verified', async () => {
    const backend = new GltfMetaBackend();
    expect(backend.type).toBe('model');
    const { manifest, fetch } = serve({
      [SHIP_SLOOP_ID]: SHIP_SLOOP_GLB_PATH,
      vehicle: VEHICLE_GLB_PATH,
    });
    const loader = new AssetLoader(manifest, [backend], { fetch, verifyHashes: true });
    const group = await loader.acquireGroup([SHIP_SLOOP_ID, 'vehicle']);
    const [ship, vehicle] = group.handles.map((h) => h.asset as ModelMeta);
    expect(fetch.mock.calls.map(([url, init]) => [url, init?.integrity])).toEqual([
      ['/assets/models/ship.sloop.glb', manifest.assets[SHIP_SLOOP_ID]?.hash],
      ['/assets/models/vehicle.glb', manifest.assets.vehicle?.hash],
    ]);

    expect(ship).toEqual(deriveModelMeta(parseGlb(fixture).json, SHIP_SLOOP_ID));
    expect(ship?.colliders.map((c) => c.kind)).toEqual(['box', 'sphere', 'capsule', 'convex']);
    expect(loader.peek(SHIP_SLOOP_ID)).toBe(ship);

    expect(vehicle).toEqual(vehicleMeta());
    expect(vehicle).toMatchObject({ id: 'vehicle', root: 'vehicle', animations: [] });
    expect(vehicle?.rootNode).not.toBeNull();
    expect(vehicle?.lods.map((l) => l.distance)).toEqual([0, 40, 120]);
    expect(vehicle?.colliders).toHaveLength(1);
    expect(vehicle?.colliders[0]).toMatchObject({
      kind: 'box',
      name: 'vehicle_COL_box',
      halfExtents: { x: 1, y: 0.75, z: 2 },
    });
    const sockets = new Map(vehicle?.sockets.map((s) => [s.name, s]));
    expect([...sockets.keys()].sort()).toEqual(['camera', 'horn']);
    // Forward is +Z (docs/assets.md §5.1): the horn is at the front, the camera behind.
    expect(sockets.get('horn')?.position.z).toBeGreaterThan(0);
    expect(sockets.get('camera')?.position.z).toBeLessThan(0);
    loader.dispose();
  });

  it('parses only the JSON chunk: a BIN chunk running past the end of the file is never read', async () => {
    const bytes = vehicleBytes.slice();
    const dv = new DataView(bytes.buffer);
    const binAt = GLB_HEADER_BYTES + 8 + dv.getUint32(GLB_HEADER_BYTES, true);
    expect(dv.getUint32(binAt + 4, true)).toBe(GLB_CHUNK_BIN);
    dv.setUint32(binAt, 0xffff_fff0, true);
    bytes.fill(0xff, binAt + 8);
    expect(parseError(bytes)).toBe('truncated'); // what scanning the BIN chunk would throw
    const { manifest, fetch } = serve({ vehicle: bytes });
    const loader = new AssetLoader(manifest, [new GltfMetaBackend()], {
      fetch,
      verifyHashes: true,
    });
    const handle = await loader.acquire<ModelMeta>('vehicle');
    expect(handle.asset).toEqual(vehicleMeta());
  });

  it('dispose is a no-op: the meta is intact after grace expiry and loader.dispose()', async () => {
    const backend = new GltfMetaBackend();
    const dispose = vi.spyOn(backend, 'dispose');
    const timers = new ManualTimers();
    const { manifest, fetch } = serve({ vehicle: VEHICLE_GLB_PATH });
    const loader = new AssetLoader(manifest, [backend], timers.options({ fetch }));
    const events = recordEvents(loader);

    const first = await loader.acquire<ModelMeta>('vehicle');
    const meta = first.asset;
    first.release();
    expect(timers.fireAll()).toBe(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(dispose.mock.calls[0]?.[0]).toBe(meta);
    expect(events).toEqual(['loaded vehicle', 'unloaded vehicle']);
    expect(loader.state('vehicle')).toBe('idle');
    expect(meta).toEqual(vehicleMeta());

    const second = await loader.acquire<ModelMeta>('vehicle');
    expect(fetch).toHaveBeenCalledTimes(2);
    loader.dispose();
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(dispose.mock.calls[1]?.[0]).toBe(second.asset);
    expect(second.asset).toEqual(vehicleMeta());
    expect(backend.dispose(meta)).toBeUndefined();
    expect(meta).toEqual(vehicleMeta());
  });

  it.each([
    ['honours', false],
    ['ignores', true],
  ] as const)(
    'aborting a loading acquisition aborts the load, which loads and disposes nothing (fetch %s the signal)',
    async (_fetch, ignoreSignal) => {
      const backend = new GltfMetaBackend();
      const load = vi.spyOn(backend, 'load');
      const dispose = vi.spyOn(backend, 'dispose');
      let open = (): void => undefined;
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      const { manifest, fetch } = serve({ vehicle: VEHICLE_GLB_PATH }, { gate, ignoreSignal });
      const loader = new AssetLoader(manifest, [backend], { fetch });
      const events = recordEvents(loader);
      const abort = new AbortController();
      const pending = loader.acquire<ModelMeta>('vehicle', 'high', abort.signal);
      await flush();
      expect(loader.state('vehicle')).toBe('loading');
      const fetchSignal = fetch.mock.calls[0]?.[1]?.signal;
      expect(fetchSignal?.aborted).toBe(false);

      const reason = new Error('region dropped');
      abort.abort(reason);
      await expect(pending).rejects.toBe(reason);
      expect(fetchSignal?.aborted).toBe(true);
      open();
      await expect(load.mock.results[0]?.value).rejects.toMatchObject({ name: 'AbortError' });
      await flush();
      expect(loader.state('vehicle')).toBe('idle');
      expect(events).toEqual([]);
      expect(dispose).not.toHaveBeenCalled();

      const handle = await loader.acquire<ModelMeta>('vehicle');
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(handle.asset).toEqual(vehicleMeta());
      expect(events).toEqual(['loaded vehicle']);
    },
  );

  it('a file that is not a GLB rejects with GlbParseError and leaves the asset in error', async () => {
    const { manifest, fetch } = serve({ vehicle: new TextEncoder().encode('{"asset":{}}') });
    const loader = new AssetLoader(manifest, [new GltfMetaBackend()], { fetch });
    const events = recordEvents(loader);
    const error = await loader.acquire('vehicle').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GlbParseError);
    expect(error).toMatchObject({ code: 'bad_magic' });
    expect(loader.state('vehicle')).toBe('error');
    expect(events).toEqual(['error vehicle']);
  });
});

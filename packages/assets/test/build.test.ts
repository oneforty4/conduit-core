import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateManifest } from '../src/index.ts';
import {
  BuildInputError,
  buildManifest,
  expandPatterns,
  idFromPath,
  typeFromExt,
  type BuildOptions,
} from '../src/node.ts';
import { makeShipSloopGlb } from './fixtures/make-glb.ts';

let root: string;
let src: string;
let out: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'conduit-assets-build-'));
  src = path.join(root, 'src');
  out = path.join(root, 'out');
  await mkdir(src);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function put(rel: string, content: string | Uint8Array, base = src): Promise<Buffer> {
  const file = path.join(base, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  return readFile(file);
}

const hex8 = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex').slice(0, 8);

const sri = (bytes: Uint8Array): string =>
  `sha256-${createHash('sha256').update(bytes).digest('base64')}`;

async function build(opts: Partial<BuildOptions> = {}) {
  const lines: string[] = [];
  const result = await buildManifest({
    srcDir: src,
    outDir: out,
    log: (l) => lines.push(l),
    ...opts,
  });
  return { ...result, lines };
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join('/'))
    .sort();
}

describe('idFromPath and typeFromExt', () => {
  it('derives ids from relative paths', () => {
    expect(idFromPath('models/ship/sloop.glb')).toBe('models.ship.sloop');
    expect(idFromPath('crate.glb')).toBe('crate');
    expect(idFromPath('Textures/Ship/Sloop Albedo.PNG')).toBe('textures.ship.sloop_albedo');
    expect(idFromPath('ui/icons/gear-2x.webp')).toBe('ui.icons.gear_2x');
    expect(idFromPath('data/level.v2.json')).toBe('data.level_v2');
    expect(idFromPath('-sfx/horn.ogg')).toBe('sfx.horn');
    expect(idFromPath('Ü_mlauts/x.bin')).toBe('mlauts.x');
    expect(idFromPath('LICENSE')).toBe('license');
    // Still invalid (the first segment may not contain '_'): validation reports bad_id.
    expect(idFromPath('sfx_horn.ogg')).toBe('sfx_horn');
  });

  it('maps extensions to types case-insensitively and returns null for non-assets', () => {
    expect(typeFromExt('.glb')).toBe('model');
    for (const ext of ['.png', '.jpg', '.JPEG', 'webp', '.ktx2'])
      expect(typeFromExt(ext), ext).toBe('texture');
    for (const ext of ['.ogg', '.mp3', '.WAV']) expect(typeFromExt(ext), ext).toBe('audio');
    expect(typeFromExt('.json')).toBe('json');
    expect(typeFromExt('.bin')).toBe('binary');
    expect(typeFromExt('.gltf')).toBe('binary');
    for (const ext of ['.blend', '.blend1', '.psd', '.md', '', '.toString']) {
      expect(typeFromExt(ext), ext).toBeNull();
    }
  });
});

describe('expandPatterns', () => {
  const ids = ['sfx.horn', 'ui', 'ui.icons.gear', 'ui.theme', 'uix.panel'];

  it('expands exact ids and prefix.* in pattern order without duplicates', () => {
    const { groups, errors } = expandPatterns(
      { core: ['ui.*', 'sfx.horn', 'ui.theme'], all_ui: ['ui', 'ui.*'] },
      ids,
    );
    expect(errors).toEqual([]);
    expect(groups).toEqual({
      all_ui: ['ui', 'ui.icons.gear', 'ui.theme'],
      core: ['ui.icons.gear', 'ui.theme', 'sfx.horn'],
    });
    expect(Object.keys(groups)).toEqual(['all_ui', 'core']);
  });

  it('reports patterns that match nothing or misuse *', () => {
    const { errors } = expandPatterns({ g: ['nope', 'nope.*', 'ui*', '*', 'ui.*.gear'] }, ids);
    expect(errors.map((e) => `${e.code} ${e.path}`)).toEqual([
      'unknown_group_asset groups.g[0]',
      'unknown_group_asset groups.g[1]',
      'unknown_group_asset groups.g[2]',
      'unknown_group_asset groups.g[3]',
      'unknown_group_asset groups.g[4]',
    ]);
  });
});

describe('buildManifest', () => {
  it('builds content-hashed copies and a sorted, valid manifest.json', async () => {
    const glb = await put('models/ship/sloop.glb', makeShipSloopGlb());
    const albedo = await put('textures/ship/sloop_albedo.png', 'png bytes');
    const horn = await put('sfx/horn.ogg', 'ogg bytes');
    const gear = await put('ui/icons/gear.webp', 'webp bytes');
    const theme = await put('ui/theme.json', '{"accent":"#fc0"}');
    const nav = await put('data/navmesh.bin', new Uint8Array([1, 2, 3]));
    await put('models/ship/sloop.blend', 'blender source');
    await put('notes.md', '# not an asset');
    await put('.DS_Store', 'finder');
    await put('_drafts/wip.png', 'draft');
    await put('ui/.cache/x.json', '{}');
    await put(
      'conduit-assets.json',
      JSON.stringify({
        groups: { core: ['ui.*', 'sfx.horn'], ships: ['models.ship.*'] },
        deps: { 'models.ship.sloop': ['textures.ship.sloop_albedo'] },
      }),
    );

    const result = await build();
    expect(result.errors).toEqual([]);
    const { manifest } = result;
    expect(Object.keys(manifest.assets)).toEqual([
      'data.navmesh',
      'models.ship.sloop',
      'sfx.horn',
      'textures.ship.sloop_albedo',
      'ui.icons.gear',
      'ui.theme',
    ]);
    expect(manifest.assets['models.ship.sloop']).toEqual({
      type: 'model',
      url: `models/ship/sloop.${hex8(glb)}.glb`,
      hash: sri(glb),
      size: glb.length,
      deps: ['textures.ship.sloop_albedo'],
    });
    const expected: [string, string, Buffer, string][] = [
      ['data.navmesh', 'binary', nav, 'data/navmesh.HEX.bin'],
      ['sfx.horn', 'audio', horn, 'sfx/horn.HEX.ogg'],
      ['textures.ship.sloop_albedo', 'texture', albedo, 'textures/ship/sloop_albedo.HEX.png'],
      ['ui.icons.gear', 'texture', gear, 'ui/icons/gear.HEX.webp'],
      ['ui.theme', 'json', theme, 'ui/theme.HEX.json'],
    ];
    for (const [id, type, bytes, url] of expected) {
      expect(manifest.assets[id], id).toEqual({
        type,
        url: url.replace('HEX', hex8(bytes)),
        hash: sri(bytes),
        size: bytes.length,
      });
    }
    expect(manifest.baseUrl).toBe('/assets/');
    expect(manifest.groups).toEqual({
      core: ['ui.icons.gear', 'ui.theme', 'sfx.horn'],
      ships: ['models.ship.sloop'],
    });
    expect(manifest.regions).toEqual({});

    const urls = Object.values(manifest.assets).map((a) => a.url);
    expect(await listFiles(out)).toEqual([...urls, 'manifest.json'].sort());
    expect(result.written).toEqual([
      ...Object.values(manifest.assets).map((a) => path.join(out, ...a.url.split('/'))),
      path.join(out, 'manifest.json'),
    ]);
    expect(await readFile(path.join(out, `models/ship/sloop.${hex8(glb)}.glb`))).toEqual(glb);
    const text = await readFile(path.join(out, 'manifest.json'), 'utf8');
    expect(text).toBe(`${JSON.stringify(manifest, null, 2)}\n`);
    expect(validateManifest(JSON.parse(text))).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.lines).toContain("skip models/ship/sloop.blend: '.blend' is not an asset type");
    expect(result.lines).toContain("skip notes.md: '.md' is not an asset type");
    expect(result.lines.some((l) => l.includes('DS_Store') || l.includes('wip'))).toBe(false);
  });

  it('keeps Blender sources beside their exports (the sandbox layout)', async () => {
    const crate = await put('crate.glb', makeShipSloopGlb());
    await put('crate.blend', 'source');
    await put('crate.blend1', 'backup');
    await put('vehicle.glb', 'vehicle export');
    await put('vehicle.blend', 'source');
    await put(
      'conduit-assets.json',
      JSON.stringify({ groups: { core: ['vehicle', 'crate'] } }),
      root,
    );
    const result = await build({ srcDir: src });
    expect(result.errors).toEqual([]);
    expect(Object.keys(result.manifest.assets)).toEqual(['crate', 'vehicle']);
    expect(result.manifest.assets.crate?.url).toBe(`crate.${hex8(crate)}.glb`);
    expect(result.manifest.groups).toEqual({ core: ['vehicle', 'crate'] });
    expect(result.lines.filter((l) => l.startsWith('skip '))).toEqual([
      "skip crate.blend: '.blend' is not an asset type",
      "skip crate.blend1: '.blend1' is not an asset type",
      "skip vehicle.blend: '.blend' is not an asset type",
    ]);
    expect(result.lines[0]).toMatch(/^config .*conduit-assets\.json$/);
  });

  it('prefers a config inside srcDir over one in its parent', async () => {
    await put('a.json', '{}');
    await put('conduit-assets.json', JSON.stringify({ baseUrl: '/inner/' }));
    await put('conduit-assets.json', JSON.stringify({ baseUrl: '/outer/' }), root);
    expect((await build()).manifest.baseUrl).toBe('/inner/');
    expect((await build({ baseUrl: 'https://cdn.example.com/v1/' })).manifest.baseUrl).toBe(
      'https://cdn.example.com/v1/',
    );
  });

  it('--graph fills regions from a WorldGraphJson, deduped and sorted', async () => {
    await put('models/ship/sloop.glb', makeShipSloopGlb());
    await put('sfx/horn.ogg', 'ogg');
    const origin = { x: 0, y: 0, z: 0 };
    const graph = {
      version: 1,
      kind: 'node',
      regions: [
        {
          id: 'port',
          kind: 'node',
          bounds: { kind: 'node', origin },
          neighbors: ['open_sea'],
          assets: ['models.ship.sloop', 'sfx.horn', 'models.ship.sloop'],
          seed: 1,
        },
        {
          id: 'open_sea',
          kind: 'node',
          bounds: { kind: 'node', origin },
          neighbors: ['port'],
          assets: [],
          seed: 2,
        },
      ],
    };
    const graphPath = path.join(root, 'world.json');
    await writeFile(graphPath, JSON.stringify(graph));
    const result = await build({ graphPath });
    expect(result.errors).toEqual([]);
    expect(result.manifest.regions).toEqual({
      open_sea: [],
      port: ['models.ship.sloop', 'sfx.horn'],
    });
    expect(Object.keys(result.manifest.regions)).toEqual(['open_sea', 'port']);
  });

  it('an unknown region asset is an error and nothing is written', async () => {
    await put('sfx/horn.ogg', 'ogg');
    const graphPath = path.join(root, 'world.json');
    await writeFile(
      graphPath,
      JSON.stringify({
        version: 1,
        kind: 'node',
        regions: [{ id: 'port', assets: ['sfx.foghorn'] }],
      }),
    );
    const result = await build({ graphPath });
    expect(result.errors).toEqual([
      {
        code: 'unknown_region_asset',
        path: 'regions.port[0]',
        message: "'sfx.foghorn' is not an asset",
      },
    ]);
    expect(result.written).toEqual([]);
    expect(existsSync(out)).toBe(false);
  });

  it('--clean removes stale outputs and empty directories', async () => {
    await put('sfx/horn.ogg', 'ogg v1');
    const first = await build();
    await put('sfx/horn.ogg', 'ogg v2');
    await put('stale/deep/old.png', 'old', out);
    await put('.gitkeep', '', out);

    const kept = await build();
    expect(kept.removed).toEqual([]);
    expect(await listFiles(out)).toHaveLength(5);

    const cleaned = await build({ clean: true });
    expect(cleaned.errors).toEqual([]);
    expect(cleaned.removed).toEqual(
      [first.written[0], path.join(out, '.gitkeep'), path.join(out, 'stale/deep/old.png')].sort(),
    );
    expect(await listFiles(out)).toEqual(
      [cleaned.manifest.assets['sfx.horn']?.url ?? '', 'manifest.json'].sort(),
    );
    expect(existsSync(path.join(out, 'stale'))).toBe(false);
    expect(cleaned.lines).toContain('removed 3 stale files');
  });

  it('expands config groups and reports patterns that match nothing', async () => {
    await put('ui/icons/gear.webp', 'gear');
    await put('ui/theme.json', '{}');
    await put('conduit-assets.json', JSON.stringify({ groups: { hud: ['ui.*'], fx: ['sfx.*'] } }));
    const result = await build();
    expect(result.manifest.groups).toEqual({ fx: [], hud: ['ui.icons.gear', 'ui.theme'] });
    expect(result.errors).toEqual([
      {
        code: 'unknown_group_asset',
        path: 'groups.fx[0]',
        message: "pattern 'sfx.*' matches no asset",
      },
    ]);
    expect(result.written).toEqual([]);
  });

  it('reports duplicate ids, invalid ids with their source file, and deps on unknown assets', async () => {
    await put('ui/theme.json', '{}');
    await put('ui/theme.png', 'png');
    await put('sfx_horn.ogg', 'ogg');
    await put('conduit-assets.json', JSON.stringify({ deps: { 'ui.ghost': ['ui.theme'] } }));
    const result = await build();
    expect(result.errors).toEqual([
      {
        code: 'bad_id',
        path: 'assets.ui.theme',
        message: 'duplicate id from ui/theme.png and ui/theme.json',
      },
      { code: 'unknown_dep', path: 'deps.ui.ghost', message: 'deps names unknown asset ui.ghost' },
      {
        code: 'bad_id',
        path: 'assets.sfx_horn',
        message: `asset id 'sfx_horn' must match ${String(/^[a-z0-9]+(\.[a-z0-9_]+)*$/)} and be at most 128 characters (from sfx_horn.ogg)`,
      },
    ]);
    expect(existsSync(out)).toBe(false);
  });

  it('does not walk an outDir inside srcDir', async () => {
    await put('sfx/horn.ogg', 'ogg');
    const nested = path.join(src, 'build');
    const first = await buildManifest({ srcDir: src, outDir: nested });
    expect(first.errors).toEqual([]);
    const second = await buildManifest({ srcDir: src, outDir: nested });
    expect(Object.keys(second.manifest.assets)).toEqual(['sfx.horn']);
  });

  it('rejects unreadable inputs with BuildInputError', async () => {
    await expect(build({ srcDir: path.join(root, 'missing') })).rejects.toBeInstanceOf(
      BuildInputError,
    );
    await expect(build({ outDir: src })).rejects.toThrow('outDir must differ from srcDir');
    await expect(build({ outDir: root, clean: true })).rejects.toThrow('refusing to clean');
    const graphPath = path.join(root, 'nope.json');
    await expect(build({ graphPath })).rejects.toMatchObject({ path: graphPath });
    await put('world.json', '{"regions": 3}', root);
    await expect(build({ graphPath: path.join(root, 'world.json') })).rejects.toThrow(
      'regions array',
    );
    await put('conduit-assets.json', '{"groups": {"core": "ui.*"}}');
    await expect(build()).rejects.toThrow('groups must map names to arrays of strings');
    await put('conduit-assets.json', '{"group": {}}');
    await expect(build()).rejects.toThrow("unknown config property 'group'");
    await put('conduit-assets.json', '{nope');
    const error = await build().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BuildInputError);
    expect(error).toMatchObject({ path: path.join(src, 'conduit-assets.json') });
  });
});

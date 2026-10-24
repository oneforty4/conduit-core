import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { USAGE, buildManifest, checkManifest, cli } from '../src/node.ts';
import { encodeGlb, makeShipSloopGlb, shipSloopGltf } from './fixtures/make-glb.ts';

let root: string;
let src: string;
let out: string;
let manifestPath: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'conduit-assets-check-'));
  src = path.join(root, 'src');
  out = path.join(root, 'out');
  manifestPath = path.join(out, 'manifest.json');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function put(rel: string, content: string | Uint8Array): Promise<void> {
  const file = path.join(src, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

/** Builds `src` into `out` and returns the path of each asset's output file by id. */
async function buildFixture(): Promise<Record<string, string>> {
  const result = await buildManifest({ srcDir: src, outDir: out });
  expect(result.errors).toEqual([]);
  return Object.fromEntries(
    Object.entries(result.manifest.assets).map(([id, e]) => [
      id,
      path.join(out, ...e.url.split('/')),
    ]),
  );
}

async function runCli(
  argv: string[],
): Promise<{ code: number; stdout: string[]; stderr: string[] }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await cli(argv, { stdout: (s) => stdout.push(s), stderr: (s) => stderr.push(s) });
  return { code, stdout, stderr };
}

describe('checkManifest', () => {
  beforeEach(async () => {
    await put('ship/sloop.glb', makeShipSloopGlb());
    await put('ui/theme.json', '{"accent":"#fc0"}');
    await put('sfx/horn.ogg', 'OggS horn');
  });

  it('passes a fresh build', async () => {
    await buildFixture();
    const lines: string[] = [];
    expect(await checkManifest({ manifestPath, log: (l) => lines.push(l) })).toEqual([]);
    expect(lines).toEqual([`checked 3 assets in ${out}: 0 failures`]);
  });

  it('a modified byte is hash_mismatch; a changed length is also size_mismatch', async () => {
    const files = await buildFixture();
    const theme = files['ui.theme'] ?? '';
    const bytes = await readFile(theme);
    bytes[2] = 0x21;
    await writeFile(theme, bytes);
    expect((await checkManifest({ manifestPath })).map((f) => `${f.code} ${f.id}`)).toEqual([
      'hash_mismatch ui.theme',
    ]);
    await writeFile(files['sfx.horn'] ?? '', 'OggS horn!');
    expect((await checkManifest({ manifestPath })).map((f) => `${f.code} ${f.id}`)).toEqual([
      'size_mismatch sfx.horn',
      'hash_mismatch sfx.horn',
      'hash_mismatch ui.theme',
    ]);
  });

  it('a deleted file is missing_file', async () => {
    const files = await buildFixture();
    await unlink(files['ship.sloop'] ?? '');
    const failures = await checkManifest({ manifestPath });
    expect(failures).toEqual([
      { id: 'ship.sloop', code: 'missing_file', message: expect.stringContaining('ship/sloop.') },
    ]);
  });

  it('--dir points at the content files when the manifest lives elsewhere', async () => {
    await buildFixture();
    const moved = path.join(root, 'manifest.json');
    await writeFile(moved, await readFile(manifestPath));
    expect(await checkManifest({ manifestPath: moved, dir: out })).toEqual([]);
    expect((await checkManifest({ manifestPath: moved })).map((f) => f.code)).toEqual([
      'missing_file',
      'missing_file',
      'missing_file',
    ]);
  });

  it('a model that is not a GLB is glb_parse', async () => {
    await put('ship/sloop.glb', 'not a glb at all');
    await buildFixture();
    const failures = await checkManifest({ manifestPath });
    expect(failures).toEqual([
      { id: 'ship.sloop', code: 'glb_parse', message: expect.stringContaining('bad GLB magic') },
    ]);
  });

  it('naming problems are reported per model', async () => {
    const { json, bin } = shipSloopGltf();
    const sail = (json.animations as { name: string }[])[1];
    if (sail) sail.name = 'Sail';
    await put('ship/sloop.glb', encodeGlb(json, bin));
    await buildFixture();
    expect(await checkManifest({ manifestPath })).toEqual([
      { id: 'ship.sloop', code: 'animation_name', message: expect.stringContaining("'Sail'") },
    ]);
  });

  it('an invalid or unreadable manifest is manifest_invalid', async () => {
    await buildFixture();
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { baseUrl: string };
    manifest.baseUrl = 'assets';
    await writeFile(manifestPath, JSON.stringify(manifest));
    expect(await checkManifest({ manifestPath })).toEqual([
      {
        id: null,
        code: 'manifest_invalid',
        message: 'bad_base_url baseUrl: baseUrl must be a string ending in \'/\', got "assets"',
      },
    ]);
    const missing = await checkManifest({ manifestPath: path.join(root, 'nope.json') });
    expect(missing).toMatchObject([{ id: null, code: 'manifest_invalid' }]);
  });
});

describe('cli', () => {
  it('a .glb whose root is misnamed fails check with root_missing and exit code 2', async () => {
    await put('boat.glb', makeShipSloopGlb());
    const built = await runCli(['build', src, out]);
    expect(built.code).toBe(0);
    expect(built.stderr).toEqual([]);
    const checked = await runCli(['check', manifestPath]);
    expect(checked.code).toBe(2);
    expect(checked.stderr).toEqual([
      "root_missing boat: no node named 'boat' (the asset id with '.' replaced by '_') in scene 0",
    ]);
  });

  it('build then check succeeds with exit code 0', async () => {
    await put('ship/sloop.glb', makeShipSloopGlb());
    await put('crate.blend', 'blender');
    const graph = path.join(root, 'world.json');
    await writeFile(
      graph,
      JSON.stringify({
        version: 1,
        kind: 'node',
        regions: [{ id: 'port', assets: ['ship.sloop'] }],
      }),
    );
    const built = await runCli([
      'build',
      src,
      out,
      '--graph',
      graph,
      '--base-url=/cdn/',
      '--clean',
    ]);
    expect(built).toMatchObject({ code: 0, stderr: [] });
    expect(built.stdout).toContain("skip crate.blend: '.blend' is not an asset type");
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      baseUrl: string;
      regions: unknown;
    };
    expect(manifest.baseUrl).toBe('/cdn/');
    expect(manifest.regions).toEqual({ port: ['ship.sloop'] });
    const checked = await runCli(['check', manifestPath, '--dir', out]);
    expect(checked).toMatchObject({ code: 0, stderr: [] });
  });

  it('build failures print one line per error and exit 2', async () => {
    await put('ui/theme.json', '{}');
    await put('ui/theme.png', 'png');
    const result = await runCli(['build', src, out]);
    expect(result.code).toBe(2);
    expect(result.stderr).toEqual([
      'bad_id assets.ui.theme: duplicate id from ui/theme.png and ui/theme.json',
    ]);
  });

  it('unreadable inputs print input_error and exit 2', async () => {
    const result = await runCli(['build', path.join(root, 'missing'), out]);
    expect(result.code).toBe(2);
    expect(result.stderr).toEqual([
      `input_error ${path.join(root, 'missing')}: source directory not found`,
    ]);
  });

  it('--help and parse errors print usage and exit 1', async () => {
    expect(await runCli(['--help'])).toEqual({ code: 1, stdout: [USAGE], stderr: [] });
    expect(await runCli([])).toEqual({ code: 1, stdout: [USAGE], stderr: [] });
    const cases: [string[], string][] = [
      [['publish'], "error: unknown command 'publish'"],
      [['build', src], 'error: build: missing <outDir>'],
      [['build', src, out, 'extra'], 'error: build: unexpected argument extra'],
      [['build', src, out, '--graph'], 'error: --graph needs a value'],
      [['build', src, out, '--verbose'], 'error: unknown option --verbose'],
      [['check'], 'error: check: missing <manifest.json>'],
      [['check', manifestPath, '--clean'], 'error: unknown option --clean'],
    ];
    for (const [argv, message] of cases) {
      expect(await runCli(argv), argv.join(' ')).toEqual({
        code: 1,
        stdout: [],
        stderr: [message, USAGE],
      });
    }
    expect(USAGE.split('\n')).toEqual([
      'conduit-assets build <srcDir> <outDir> [--graph <world.json>] [--base-url </assets/>] [--clean]',
      'conduit-assets check <manifest.json> [--dir <outDir>]',
    ]);
  });
});

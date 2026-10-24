import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const bin = fileURLToPath(new URL('../bin/conduit-assets.mjs', import.meta.url));
// Spawning node and compiling @conduit/assets through tsx takes a moment on a cold cache.
const SPAWN_TIMEOUT_MS = 60_000;

function run(args: string[]) {
  return spawnSync(process.execPath, [bin, ...args], {
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT_MS,
  });
}

describe('bin/conduit-assets.mjs', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'conduit-assets-bin-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it.skipIf(process.platform === 'win32')('is executable with a node shebang', () => {
    expect(statSync(bin).mode & 0o111).not.toBe(0);
    expect(readFileSync(bin, 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true);
  });

  it(
    '--help exits 1 and prints usage',
    () => {
      const result = run(['--help']);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('conduit-assets build <srcDir> <outDir>');
      expect(result.stdout).toContain('conduit-assets check <manifest.json>');
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    'build on a two-file directory exits 0 and writes manifest.json',
    () => {
      const src = path.join(root, 'src');
      const out = path.join(root, 'out');
      mkdirSync(path.join(src, 'sfx'), { recursive: true });
      writeFileSync(path.join(src, 'sfx', 'horn.ogg'), 'OggS');
      writeFileSync(path.join(src, 'theme.json'), '{"accent":"#fc0"}');

      const result = run(['build', src, out]);
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      const manifest = JSON.parse(readFileSync(path.join(out, 'manifest.json'), 'utf8')) as {
        assets: Record<string, { type: string; url: string }>;
      };
      expect(Object.keys(manifest.assets)).toEqual(['sfx.horn', 'theme']);
      expect(manifest.assets['sfx.horn']?.type).toBe('audio');
      expect(manifest.assets.theme?.url).toMatch(/^theme\.[0-9a-f]{8}\.json$/);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    'exits 2 when check finds a problem',
    () => {
      const manifest = path.join(root, 'manifest.json');
      writeFileSync(manifest, JSON.stringify({ version: 2 }));
      const result = run(['check', manifest]);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('manifest_invalid');
    },
    SPAWN_TIMEOUT_MS,
  );
});

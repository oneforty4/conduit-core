import { fileURLToPath } from 'node:url';
import { build, type Metafile } from 'esbuild';
import { describe, expect, it } from 'vitest';

// docs/game.md 5: nothing Node-only is reachable from @conduit/game/client, and @conduit/render
// (with three) is only a dynamic import, so bundlers split it off. A host-mode browser app bundles
// @conduit/lobby-client next to it (the `lobby` option), which must not pull in the lobby either.

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const ENTRY = 'packages/game/src/client.ts';
const LOBBY_CLIENT_ENTRY = 'packages/lobby-client/src/index.ts';
/** Node-only packages the browser bundle must never contain (M5 added host, lobby and auth). */
const NODE_PACKAGES = ['host', 'lobby', 'auth', 'net-server', 'persist'] as const;

function nodeOnly(path: string): boolean {
  return (
    /(^|\/)node_modules\/ws\//.test(path) ||
    path.startsWith('node:') ||
    /packages\/(net-server|persist|host|auth|lobby)\//.test(path)
  );
}

type Output = Metafile['outputs'][string];

function output(meta: Metafile, path: string): Output {
  const out = meta.outputs[path];
  if (out === undefined) throw new Error(`no output ${path}`);
  return out;
}

/** `start` plus every output it reaches through static imports. */
function staticClosure(meta: Metafile, start: string): string[] {
  const seen = new Set<string>([start]);
  const queue = [start];
  for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
    for (const imp of output(meta, path).imports) {
      if (imp.kind !== 'import-statement' || imp.external === true || seen.has(imp.path)) continue;
      seen.add(imp.path);
      queue.push(imp.path);
    }
  }
  return [...seen];
}

describe('client isolation', () => {
  it('imports src/client.ts with a browser-like global', async () => {
    const scope = globalThis as unknown as { window?: unknown };
    scope.window = {};
    try {
      const mod = await import('../src/client.ts');
      expect(typeof mod.createClient).toBe('function');
      expect(mod.HEADLESS_FRAME_MS).toBeCloseTo(1000 / 60, 9);
    } finally {
      delete scope.window;
    }
  });

  it('bundles for the browser without Node-only modules and with render split off', async () => {
    const result = await build({
      absWorkingDir: REPO_ROOT,
      entryPoints: [ENTRY, LOBBY_CLIENT_ENTRY],
      bundle: true,
      platform: 'browser',
      format: 'esm',
      splitting: true,
      outdir: 'out',
      write: false,
      metafile: true,
      external: ['three'],
      logLevel: 'silent',
    });
    const meta = result.metafile;
    const inputs = Object.keys(meta.inputs);
    expect(inputs).toContain(ENTRY);
    expect(inputs.filter(nodeOnly)).toEqual([]);
    for (const name of NODE_PACKAGES) {
      expect(
        inputs.filter((path) => path.startsWith(`packages/${name}/`)),
        `packages/${name}`,
      ).toEqual([]);
    }
    // The isomorphic lobby client is bundled (the second entry), its lobby imports being type-only;
    // the game client itself only names its type, so no lobby-client source is in its closure.
    expect(inputs).toContain(LOBBY_CLIENT_ENTRY);

    const entry = Object.keys(meta.outputs).find(
      (path) => meta.outputs[path]?.entryPoint === ENTRY,
    );
    if (entry === undefined) throw new Error('no output for the client entry');

    // What loads with the client: no render sources, no three, no lobby client.
    for (const path of staticClosure(meta, entry)) {
      const out = output(meta, path);
      expect(Object.keys(out.inputs).filter((p) => p.startsWith('packages/render/'))).toEqual([]);
      expect(Object.keys(out.inputs).filter((p) => p.startsWith('packages/lobby-client/'))).toEqual(
        [],
      );
      expect(out.imports.filter((imp) => imp.path === 'three')).toEqual([]);
    }

    // The render module is a dynamic import whose chunk imports three.
    const dynamic = output(meta, entry).imports.filter((imp) => imp.kind === 'dynamic-import');
    expect(dynamic).toHaveLength(1);
    const renderChunk = output(meta, (dynamic[0] as { path: string }).path);
    expect(renderChunk.entryPoint).toBe('packages/render/src/index.ts');
    expect(renderChunk.imports.some((imp) => imp.path === 'three' && imp.external === true)).toBe(
      true,
    );
  });
});

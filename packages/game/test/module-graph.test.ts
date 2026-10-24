import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

// docs/render.md 10.1: neither the server entry nor a headless client loads three (or
// @conduit/render). Each scenario runs in a fresh `node` whose resolve hook (trace-loader.mjs)
// records every module URL; the package is imported through its own `exports` (self-reference).

const GAME_DIR = fileURLToPath(new URL('..', import.meta.url));
const TRACE_LOADER = new URL('./trace-loader.mjs', import.meta.url).href;
/** Hoisted and pnpm virtual-store paths. */
const THREE_URL = /\/node_modules\/(\.pnpm\/[^/]*\/node_modules\/)?three\//;
const RENDER_URL = /\/packages\/render\//;

/** Nothing when Node strips types itself (>= 22.18); otherwise tsx, a dependency of the tooling package. */
function typescriptFlags(): string[] {
  if ((process.features as { typescript?: unknown }).typescript) return [];
  const toolingRequire = createRequire(join(GAME_DIR, '..', 'tooling', 'package.json'));
  return ['--import', pathToFileURL(toolingRequire.resolve('tsx/esm')).href];
}

/** Runs `script` (an ES module body) in a child node and returns every URL it resolved. */
async function trace(script: string): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), 'conduit-module-graph-'));
  const out = join(dir, 'urls.json');
  // A scenario that finished exits even if a handle keeps the loop alive (the graph, not handle
  // hygiene, is under test); one that hangs fails with exit code 3.
  const body = `let done = false;\nsetTimeout(() => process.exit(done ? 0 : 3), 5000).unref();\n${script}\ndone = true;\n`;
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        process.execPath,
        [...typescriptFlags(), '--import', TRACE_LOADER, '--input-type=module', '-e', body],
        { cwd: GAME_DIR, env: { ...process.env, CONDUIT_TRACE_OUT: out }, timeout: 30_000 },
        (err, _stdout, stderr) =>
          err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(),
      );
    });
    return JSON.parse(readFileSync(out, 'utf8')) as string[];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const SERVER_ENTRY = `await import('@conduit/game/server');`;

const HEADLESS_CLIENT_ENTRIES = `
await import('@conduit/game/server');
await import('@conduit/net-client');
await import('@conduit/game');
await import('@conduit/game/client');
`;

const HEADLESS_CLIENT_IN_USE = `
const { defineGame, defineInput, f, GridWorld, Region, Transform } = await import('@conduit/game');
const { createServer } = await import('@conduit/game/server');
const { createClient } = await import('@conduit/game/client');
const game = defineGame({
  id: 'module-graph', name: 'Module graph', protocolVersion: 1, seed: 1,
  components: [], messages: [], events: [], systems: [],
  input: defineInput({ tick: f.u32, throttle: f.i8 }),
  world: (seed) => new GridWorld({ cellSize: 64, cols: 2, rows: 2, worldSeed: seed }),
});
const server = await createServer(game, {
  devAuth: true,
  log: () => {},
  regionLoader: { populate() {} },
  hooks: {
    onPlayerJoin: () => ({
      regionId: 'cell/0_0',
      spawn(ctx) {
        const e = ctx.world.create();
        ctx.world.add(e, Region, { id: 'cell/0_0' });
        ctx.world.add(e, Transform);
        return e;
      },
    }),
  },
});
const client = createClient(game, {
  url: server.url,
  displayName: 'tracer',
  sampleInput: (ctx) => ({ tick: ctx.tick, throttle: 1 }),
});
const { localEntity } = await client.connect();
await new Promise((resolve) => setTimeout(resolve, 250));
if (client.replica.read(localEntity, Transform) === undefined) throw new Error('no snapshot arrived');
client.dispose();
await server.close();
`;

const RENDER_CONTROL = `await import('@conduit/render');`;

function matching(urls: readonly string[], pattern: RegExp): string[] {
  return urls.filter((url) => pattern.test(url));
}

describe('module graph', () => {
  let traces: { server: string[]; entries: string[]; inUse: string[]; render: string[] };

  beforeAll(async () => {
    const [server, entries, inUse, render] = await Promise.all([
      trace(SERVER_ENTRY),
      trace(HEADLESS_CLIENT_ENTRIES),
      trace(HEADLESS_CLIENT_IN_USE),
      trace(RENDER_CONTROL),
    ]);
    traces = { server, entries, inUse, render };
  }, 60_000);

  it('matches three under hoisted and pnpm virtual-store paths only', () => {
    expect(THREE_URL.test('file:///app/node_modules/three/build/three.module.js')).toBe(true);
    expect(
      THREE_URL.test('file:///app/node_modules/.pnpm/three@0.170.0/node_modules/three/build/x.js'),
    ).toBe(true);
    expect(THREE_URL.test('file:///app/node_modules/threejs-extras/index.js')).toBe(false);
  });

  it('sees three when @conduit/render is loaded (the trace works)', () => {
    expect(matching(traces.render, THREE_URL).length).toBeGreaterThan(0);
    expect(matching(traces.render, RENDER_URL).length).toBeGreaterThan(0);
  });

  it('the server entry loads no three', () => {
    expect(traces.server.some((url) => url.endsWith('/packages/game/src/server.ts'))).toBe(true);
    expect(
      traces.server.some((url) => /\/node_modules\/(\.pnpm\/[^/]*\/node_modules\/)?ws\//.test(url)),
    ).toBe(true);
    expect(matching(traces.server, THREE_URL)).toEqual([]);
    expect(matching(traces.server, RENDER_URL)).toEqual([]);
  });

  it('the headless client entries load no three', () => {
    expect(traces.entries.some((url) => url.endsWith('/packages/game/src/client.ts'))).toBe(true);
    expect(
      traces.entries.some((url) => url.endsWith('/packages/net-client/src/net-client.ts')),
    ).toBe(true);
    expect(matching(traces.entries, THREE_URL)).toEqual([]);
    expect(matching(traces.entries, RENDER_URL)).toEqual([]);
  });

  it('a headless createClient that connects, plays and disposes adds no three', () => {
    expect(traces.inUse.some((url) => url.endsWith('/packages/game/src/client.ts'))).toBe(true);
    expect(matching(traces.inUse, THREE_URL)).toEqual([]);
    expect(matching(traces.inUse, RENDER_URL)).toEqual([]);
  });
});

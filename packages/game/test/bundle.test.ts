import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LobbyClient } from '@conduit/lobby-client';
import { NetClient } from '@conduit/net-client';
import { openNodeSqlite } from '@conduit/persist';
import { build, type Metafile, type Plugin } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { game } from '../../../examples/sandbox/src/shared/game.ts';

// docs/consuming.md 4: a production host bundle. One esbuild build of the host's main thread
// (test/fixtures/bundled-host.ts, which calls createHost with workerEntry), @conduit/host/worker and
// the game module, split into shared chunks so that a session worker and the game module it imports
// use one copy of each core module. It runs as plain `node main.mjs` with only ws and hono installed
// next to it, and a lobby join starts a session worker a client plays on.

const require = createRequire(import.meta.url);
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const MAIN = fileURLToPath(new URL('./fixtures/bundled-host.ts', import.meta.url));
const GAME_MODULE = fileURLToPath(
  new URL('../../../examples/sandbox/src/server/game.ts', import.meta.url),
);
/** `packages/host`, whose `ws` and `hono` the bundle's directory links as its installed packages. */
const HOST_DIR = dirname(dirname(require.resolve('@conduit/host')));
/** 48 bytes. */
const SECRET = 'bundle-test-secret-0123456789abcdef-0123456789ab';
const PASSWORD = 'bundle-test-password';

/** docs/consuming.md 4: workspace packages are bundled from their sources, everything else stays external. */
const bundleWorkspace: Plugin = {
  name: 'bundle-workspace',
  setup(b) {
    b.onResolve({ filter: /^@conduit\// }, (args) => ({
      path: require.resolve(args.path, { paths: [args.resolveDir] }),
    }));
  },
};

function nodeSqliteSkipReason(): string | null {
  try {
    openNodeSqlite(':memory:').close();
    return null;
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ERR_UNKNOWN_BUILTIN_MODULE') {
      console.warn(`Skipping the bundled host test. ${err.message}`);
      return err.message;
    }
    throw err;
  }
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe.skipIf(nodeSqliteSkipReason() !== null)('a bundled host', { timeout: 60_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'conduit-game-bundle-'));
  let meta: Metafile;
  let child: ChildProcess | undefined;
  let client: NetClient | undefined;

  beforeAll(async () => {
    const result = await build({
      absWorkingDir: REPO_ROOT, // metafile paths relative to the repo root
      entryPoints: {
        main: MAIN,
        worker: require.resolve('@conduit/host/worker'),
        session: GAME_MODULE,
      },
      outdir: dir,
      outExtension: { '.js': '.mjs' },
      splitting: true,
      chunkNames: 'chunks/[name]-[hash]',
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      packages: 'external',
      plugins: [bundleWorkspace],
      banner: {
        js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
      },
      metafile: true,
      logLevel: 'silent',
    });
    meta = result.metafile;
    // What `pnpm install --prod` of a package.json listing ws and hono leaves next to the bundle.
    mkdirSync(join(dir, 'node_modules'));
    for (const name of ['ws', 'hono']) {
      symlinkSync(
        realpathSync(join(HOST_DIR, 'node_modules', name)),
        join(dir, 'node_modules', name),
        'junction',
      );
    }
  });

  afterAll(() => {
    client?.disconnect();
    if (child !== undefined && child.exitCode === null) child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  });

  it('holds one copy of each module and imports nothing but ws, hono and Node built-ins', () => {
    const entries = Object.values(meta.outputs).flatMap((out) =>
      out.entryPoint === undefined ? [] : [out.entryPoint],
    );
    expect(entries).toHaveLength(3);
    const copies = new Map<string, number>();
    for (const out of Object.values(meta.outputs)) {
      for (const input of Object.keys(out.inputs)) copies.set(input, (copies.get(input) ?? 0) + 1);
    }
    // A worker bundled apart from the game module would carry a second @conduit/sim, whose core
    // components the game's registry does not hold.
    expect([...copies.keys()].some((input) => input.includes('packages/sim/src/'))).toBe(true);
    expect([...copies].filter(([, n]) => n > 1)).toEqual([]);
    const external = Object.values(meta.outputs).flatMap((out) =>
      out.imports.filter((imp) => imp.external === true).map((imp) => imp.path),
    );
    expect(external.filter((path) => !/^(node:|ws$|hono($|\/))/.test(path))).toEqual([]);
  });

  it('starts a session worker from the bundled entry on a lobby join, and a client plays on it', async () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOST_SECRET: SECRET,
      DB_PATH: join(dir, 'host.sqlite'),
    };
    for (const name of ['PORT', 'STATIC_DIR', 'PUBLIC_WS_BASE', 'IDLE_TIMEOUT_MS', 'LOG_LEVEL']) {
      delete env[name];
    }
    // A heap flag as production runs use: workers get workerExecArgv [] instead of inheriting it.
    const run = spawn(process.execPath, ['--max-old-space-size=512', join(dir, 'main.mjs')], {
      cwd: dir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child = run;
    let output = '';
    run.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    run.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    const exited = new Promise<number | null>((resolve) =>
      run.once('exit', (code) => resolve(code)),
    );
    await waitFor(
      () => /listening on http:/.test(output) || run.exitCode !== null,
      'the listening line',
    );
    const url = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1];
    expect(url, output).toBeDefined();
    const base = url as string;

    const lobby = new LobbyClient({ baseUrl: base });
    await lobby.register('bundled', PASSWORD);
    await lobby.login('bundled', PASSWORD);
    const { session } = await lobby.createSession({
      gameId: game.id,
      name: 'bundled',
      visibility: 'private',
      maxPlayers: 2,
    });
    // Before workerEntry, this join answered 500: the worker was looked for next to main.mjs.
    const joined = await lobby.join(session.id).catch((err: unknown) => {
      throw new Error(`join failed: ${String(err)}\n${output}`);
    });
    const health = (await (await fetch(`${base}/healthz`)).json()) as {
      list: { sessionId: string; gameId: string; state: string }[];
    };
    expect(health.list).toEqual([
      expect.objectContaining({ sessionId: session.id, gameId: game.id, state: 'running' }),
    ]);

    const net = new NetClient({
      url: joined.wsUrl,
      game,
      token: joined.token,
      displayName: 'bundled',
      log: () => undefined,
    });
    client = net;
    let welcomed = false;
    net.on('welcome', () => (welcomed = true));
    await net.connect();
    await waitFor(() => net.state === 'Playing', 'Playing');
    expect(welcomed).toBe(true);
    net.disconnect();

    run.kill('SIGTERM');
    expect(await exited).toBe(0);
  });
});

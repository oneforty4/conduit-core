import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openApplicationSave } from '@conduit/persist';
import { WebSocket } from 'ws';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { GATEWAY_CLOSE } from '../src/constants.ts';
import { Host } from '../src/host.ts';
import { game } from './fixtures/game.ts';
import {
  createSession,
  FIXTURE_MODULE,
  joinAndConnect,
  joinSession,
  lobbyFetch,
  lobbyLogin,
  recordingLogger,
  SECRET,
  startHost,
  type TestHost,
  waitFor,
  WORKER_EXEC_ARGV,
} from './fixtures/helpers.ts';

const hosts: TestHost[] = [];
const staticDir = mkdtempSync(join(tmpdir(), 'conduit-host-static-'));
writeFileSync(join(staticDir, 'index.html'), '<title>client</title>');

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
});

afterAll(() => rmSync(staticDir, { recursive: true, force: true }));

async function started(overrides: Parameters<typeof startHost>[0] = {}): Promise<TestHost> {
  const target = await startHost(overrides);
  hosts.push(target);
  return target;
}

function bareHost(extra: Partial<ConstructorParameters<typeof Host>[0]> = {}): Host {
  return new Host({
    port: 0,
    dbPath: ':memory:',
    secret: SECRET,
    workerExecArgv: WORKER_EXEC_ARGV,
    logger: recordingLogger(),
    handleSignals: false,
    ...extra,
  });
}

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, () => probe.close(() => resolve(true)));
  });
}

describe('Host.registerGame', () => {
  it('throws for a duplicate game id', async () => {
    const host = bareHost();
    host.registerGame(game, { module: FIXTURE_MODULE });
    expect(() => host.registerGame(game, { module: FIXTURE_MODULE })).toThrow(/already registered/);
    await host.close();
  });

  it('turns paths into file URLs and falls back to HostOptions.gameModules', async () => {
    const path = new URL(FIXTURE_MODULE).pathname;
    const withPath = bareHost();
    withPath.registerGame(game, { module: path });
    expect(withPath.games.get(game.id)?.module).toBe(pathToFileURL(path).href);
    await withPath.close();

    const fromOptions = bareHost({ gameModules: { [game.id]: new URL(FIXTURE_MODULE) } });
    fromOptions.registerGame(game);
    expect(fromOptions.games.get(game.id)).toEqual({ def: game, module: FIXTURE_MODULE });
    await fromOptions.close();
  });

  it('a game registered without a module fails at its first start with no_game_module', async () => {
    const host = bareHost();
    host.registerGame(game);
    expect(host.games.get(game.id)?.module).toBeUndefined();
    await expect(host.sessions.start('01J8ZK4A5B6C7D8E9F0G1H2J3K', game.id)).rejects.toMatchObject({
      code: 'no_game_module',
    });
    const { port } = await host.listen();
    const target: TestHost = {
      host,
      port,
      url: `http://127.0.0.1:${port}`,
      logger: recordingLogger(),
      close: () => host.close(),
    };
    hosts.push(target);
    const { cookie } = await lobbyLogin(target, 'owner');
    const { id } = await createSession(target, cookie);
    // The lobby logs the 500 it answers; keep the test output quiet.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await lobbyFetch(target, cookie, `/sessions/${id}/join`, {
      method: 'POST',
      body: {},
    });
    consoleError.mockRestore();
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: 'internal' });
  });
});

describe('HostOptions.workerEntry', () => {
  const worker = fileURLToPath(new URL('../src/worker.ts', import.meta.url));
  const entryDir = mkdtempSync(join(tmpdir(), 'conduit-host-entry-'));
  afterAll(() => rmSync(entryDir, { recursive: true, force: true }));

  it('the package exports the worker entry as @conduit/host/worker', () => {
    const resolved = createRequire(import.meta.url).resolve('@conduit/host/worker');
    expect(realpathSync(resolved)).toBe(realpathSync(worker));
  });

  it('session workers start from the given entry, wherever it lives', async () => {
    // Away from session-manager.ts, as a bundle's worker is: it logs one line, then runs the entry.
    const entry = join(entryDir, 'relocated-worker.mjs');
    writeFileSync(
      entry,
      [
        "import { parentPort } from 'node:worker_threads';",
        "parentPort.postMessage({ t: 'log', level: 'info', msg: 'relocated worker entry' });",
        `await import(${JSON.stringify(pathToFileURL(worker).href)});`,
      ].join('\n'),
    );
    const target = await started({ workerEntry: pathToFileURL(entry) });
    const { cookie } = await lobbyLogin(target, 'relocated');
    const { id } = await createSession(target, cookie);
    const socket = await joinAndConnect(target, cookie, id, 'relocated');
    await socket.next('Welcome');
    expect(target.host.sessions.isRunning(id)).toBe(true);
    expect(target.logger.messages('info')).toContain(`[session ${id}] relocated worker entry`);
  });

  it('an entry that does not exist fails the start with worker_start_failed naming it', async () => {
    // What a bundle that kept the default gets: worker.ts next to its own output.
    const missing = join(entryDir, 'dist', 'worker.ts');
    const target = await started({ workerEntry: missing });
    const start = target.host.sessions.start('01J8ZK4A5B6C7D8E9F0G1H2J3K', game.id);
    await expect(start).rejects.toMatchObject({ code: 'worker_start_failed' });
    await expect(start).rejects.toThrow(missing);
  });
});

describe('Host HTTP', () => {
  it('listens on port 0 and serves GET /games from the registrations', async () => {
    const target = await started();
    expect(target.port).toBeGreaterThan(0);
    expect(target.url).toBe(`http://127.0.0.1:${target.port}`);
    const res = await fetch(`${target.url}/games`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { gameId: 'host-fixture', name: 'Host fixture', version: 1 },
    ]);
    const missing = await fetch(`${target.url}/nothing/here`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: 'not_found' });
    await expect(target.host.listen()).rejects.toThrow(/already listening/);
  });

  it('serves STATIC_DIR after the lobby routes', async () => {
    const target = await started({ staticDir });
    const page = await fetch(`${target.url}/`);
    expect(await page.text()).toBe('<title>client</title>');
    const spa = await fetch(`${target.url}/play/123`, { headers: { accept: 'text/html' } });
    expect(await spa.text()).toBe('<title>client</title>');
    expect((await fetch(`${target.url}/me`)).status).toBe(401); // lobby first
    expect((await fetch(`${target.url}/healthz`)).status).toBe(200);
  });
});

describe('Host.close', () => {
  it('closes presence with 4111, flushes and stops workers, closes the store and frees the port', async () => {
    const target = await started();
    const { cookie } = await lobbyLogin(target, 'alice');
    const { id } = await createSession(target, cookie);

    const presence = new WebSocket(`ws://127.0.0.1:${target.port}/lobby`, { headers: { cookie } });
    const presenceClosed = new Promise<number>((resolve) =>
      presence.once('close', (code) => resolve(code)),
    );
    const presenceEvents: unknown[] = [];
    presence.on('message', (data) => presenceEvents.push(JSON.parse(String(data))));
    await new Promise<void>((resolve) => presence.once('open', () => resolve()));
    presence.send(JSON.stringify({ t: 'hello' }));
    await waitFor(() => presenceEvents.length > 0, 'the friends snapshot');

    const game1 = await joinAndConnect(target, cookie, id, 'alice');
    await game1.next('Welcome');
    expect(target.host.sessions.isRunning(id)).toBe(true);

    await target.host.close();
    expect(await presenceClosed).toBe(GATEWAY_CLOSE.SHUTTING_DOWN);
    expect((await game1.closed).code).toBe(GATEWAY_CLOSE.SHUTTING_DOWN);
    expect(target.host.sessions.has(id)).toBe(false);
    // flushAll saved once, then the worker's final save once more.
    await expect(target.host.store.get('session', `${id}/state`)).rejects.toMatchObject({
      code: 'closed',
    });
    expect(target.host.store.closed).toBe(true);
    expect(await portIsFree(target.port)).toBe(true);
    await target.host.close(); // idempotent
  });

  it('flushes before stopping: the session state holds both saves', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'conduit-host-close-'));
    const dbPath = join(dir, 'host.sqlite');
    try {
      const target = await startHost({ dbPath });
      const { cookie } = await lobbyLogin(target, 'bob');
      const { id } = await createSession(target, cookie);
      await joinSession(target, cookie, id);
      await target.host.close();

      const reopened = bareHost({ dbPath });
      const save = await openApplicationSave(reopened.store, { scope: id });
      const blob = await save.get('session', 'state');
      expect(JSON.parse(new TextDecoder().decode(blob ?? new Uint8Array()))).toEqual({ saves: 2 });
      const row = reopened.store.db.prepare('SELECT state FROM sessions WHERE id = ?').get(id);
      expect(row).toEqual({ state: 'running' });
      await reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

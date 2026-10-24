import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError } from '@conduit/host';
import { LobbyClient, LobbyError } from '@conduit/lobby-client';
import { openNodeSqlite } from '@conduit/persist';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { game } from '../../../examples/sandbox/src/shared/game.ts';
import { createHost, type GameHost } from '../src/host.ts';

// docs/game.md 3: createHost's own contract. The session path through it (workers, lobby joins,
// SQLite) is the createHost run of test/headless.test.ts.

/** 48 bytes. */
const SECRET = 'game-host-test-secret-0123456789abcdef-012345678';
const PASSWORD = 'host-test-password';
/** A module the session worker cannot import. */
const MISSING_MODULE = new URL('./fixtures/does-not-exist.ts', import.meta.url);

function nodeSqliteSkipReason(): string | null {
  try {
    openNodeSqlite(':memory:').close();
    return null;
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ERR_UNKNOWN_BUILTIN_MODULE') {
      console.warn(`Skipping createHost tests. ${err.message}`);
      return err.message;
    }
    throw err;
  }
}

/** Resolves true when nothing listens on `port` any more. */
function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createNetServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, () => probe.close(() => resolve(true)));
  });
}

describe.skipIf(nodeSqliteSkipReason() !== null)('createHost', () => {
  let dir = '';
  const hosts: GameHost[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'conduit-game-host-'));
  });

  afterEach(async () => {
    for (const host of hosts.splice(0)) await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('throws for a game listed twice before opening anything, and for option errors', () => {
    const dbPath = join(dir, 'host.sqlite');
    const entry = { game, module: MISSING_MODULE };
    expect(() => createHost([entry, entry], { port: 0, dbPath, secret: SECRET })).toThrow(
      'createHost: game sandbox is listed twice',
    );
    expect(existsSync(dbPath)).toBe(false);
    expect(() => createHost([entry], { port: 0, dbPath, secret: 'too short' })).toThrow(
      ConfigError,
    );
    expect(() =>
      createHost([entry], { port: 0, dbPath, secret: SECRET, static: join(dir, 'nope') }),
    ).toThrow(ConfigError);
  });

  it('serves the lobby with the games and the static directory, routes the host log to log, and closes', async () => {
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>game</title>');
    const lines: [string, string][] = [];
    const host = await createHost([{ game, module: MISSING_MODULE }], {
      port: 0,
      dbPath: join(dir, 'host.sqlite'),
      secret: SECRET,
      static: dir,
      log: (level, msg) => lines.push([level, msg]),
    });
    hosts.push(host);
    expect(host.url).toBe(`http://127.0.0.1:${host.port}`);
    expect(Object.isFrozen(host)).toBe(true);

    const lobby = new LobbyClient({ baseUrl: host.url });
    expect(await lobby.games()).toEqual([{ gameId: 'sandbox', name: 'Sandbox', version: 1 }]);
    const page = await fetch(`${host.url}/`, { headers: { Accept: 'text/html' } });
    expect(await page.text()).toBe('<!doctype html><title>game</title>');

    // A session whose worker cannot import the module: the join fails and the host logs why,
    // prefixed with the session, through `log`.
    await lobby.register('owner', PASSWORD);
    await lobby.login('owner', PASSWORD);
    const { session } = await lobby.createSession({
      gameId: 'sandbox',
      name: 'broken',
      visibility: 'private',
      maxPlayers: 2,
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const refused: unknown = await lobby.join(session.id).catch((err: unknown) => err);
    // The lobby routes report the 500 on the console themselves (docs/host.md 10).
    expect(consoleError).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
    expect(refused).toBeInstanceOf(LobbyError);
    expect((refused as LobbyError).status).toBe(500);
    expect(lines).toContainEqual(['error', `[session ${session.id}] start failed`]);
    expect(lines.every(([level]) => ['info', 'warn', 'error'].includes(level))).toBe(true);

    await Promise.all([host.close(), host.close()]);
    expect(await portFree(host.port)).toBe(true);
  });
});

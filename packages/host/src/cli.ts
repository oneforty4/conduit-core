#!/usr/bin/env node
// conduit-host <game-module> [<game-module> ...] [--port N] [--db PATH] [--static DIR]
//   [--ws-base URL] [--idle-ms N] [--log-level L]                      (docs/host.md 22)
// Exit codes: 2 usage or configuration, 3 node:sqlite unavailable, 1 any other startup failure.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { ConfigError, loadConfig } from './config.ts';
import { Host } from './host.ts';
import { consoleLogger } from './logger.ts';

const USAGE =
  'usage: conduit-host <game-module> [<game-module> ...] [--port N] [--db PATH] [--static DIR] ' +
  '[--ws-base URL] [--idle-ms N] [--log-level L]\n' +
  '  HOST_SECRET (at least 32 bytes) must be set in the environment.';

/** Flag → the environment variable it overrides. */
const FLAG_VARIABLES = {
  port: 'PORT',
  db: 'DB_PATH',
  static: 'STATIC_DIR',
  'ws-base': 'PUBLIC_WS_BASE',
  'idle-ms': 'IDLE_TIMEOUT_MS',
  'log-level': 'LOG_LEVEL',
} as const;

function fail(message: string): void {
  process.stderr.write(`conduit-host: ${message}\n`);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sqliteUnavailable(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'ERR_UNKNOWN_BUILTIN_MODULE';
}

/**
 * Sets the exit code and lets the process end once its output is flushed; a loop still held after
 * a second is ended with `process.exit`.
 */
function exit(code: number): void {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 1000).unref();
}

const OPTIONS = {
  port: { type: 'string' },
  db: { type: 'string' },
  static: { type: 'string' },
  'ws-base': { type: 'string' },
  'idle-ms': { type: 'string' },
  'log-level': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const;

function parse(argv: string[]) {
  return parseArgs({ args: argv, allowPositionals: true, strict: true, options: OPTIONS });
}

/** Runs the CLI; resolves with an exit code, or `null` once the host is listening. */
async function main(argv: string[]): Promise<number | null> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (err) {
    fail(`${messageOf(err)}\n${USAGE}`);
    return 2;
  }
  if (parsed.values.help === true) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (parsed.positionals.length === 0) {
    fail(`no game module given\n${USAGE}`);
    return 2;
  }

  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [flag, variable] of Object.entries(FLAG_VARIABLES)) {
    const value = parsed.values[flag as keyof typeof FLAG_VARIABLES];
    if (value !== undefined) env[variable] = value;
  }
  let host: Host;
  try {
    const config = loadConfig(env);
    host = new Host({ ...config, logger: consoleLogger(config.logLevel) });
  } catch (err) {
    if (err instanceof ConfigError) {
      fail(err.message);
      return 2;
    }
    fail(messageOf(err));
    return sqliteUnavailable(err) ? 3 : 1;
  }

  try {
    for (const arg of parsed.positionals) {
      const url = pathToFileURL(resolve(arg)).href;
      const mod = (await import(url)) as {
        game?: unknown;
        sessionFactory?: unknown;
        default?: { game?: unknown; sessionFactory?: unknown } | null;
      };
      const game = mod.game ?? mod.default?.game;
      const sessionFactory = mod.sessionFactory ?? mod.default?.sessionFactory;
      if (typeof game !== 'object' || game === null || typeof sessionFactory !== 'function') {
        throw new Error(
          `${arg} must export game and sessionFactory (or a default export holding both)`,
        );
      }
      host.registerGame(game as Parameters<Host['registerGame']>[0], { module: url });
    }
    const { port } = await host.listen();
    process.stdout.write(`listening on http://0.0.0.0:${port}\n`);
    return null;
  } catch (err) {
    fail(`startup failed: ${messageOf(err)}`);
    await host.close().catch(() => undefined);
    return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code !== null) exit(code);
  },
  (err: unknown) => {
    fail(messageOf(err));
    exit(1);
  },
);

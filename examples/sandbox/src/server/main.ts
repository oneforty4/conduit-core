// `pnpm dev` server: one dev session on ws://127.0.0.1:8081 with dev auth (examples/sandbox/README.md).
//
// Environment:
//   SANDBOX_DB                  SQLite file for regions and session state (relative to this package);
//                               unset: in memory, so every start is a fresh world
//   SANDBOX_RECONNECT_GRACE_MS  how long a lost player keeps its vehicle, in ms (default 120000)
import { resolve } from 'node:path';
import { type CreateServerOpts, createServer, SqliteStore } from '@conduit/game/server';
import { game } from './game.ts';
import { createHooks } from './hooks.ts';
import { SandboxLoader } from './loader.ts';
import type { SandboxInput } from '../shared/input.ts';

const PORT = 8081;

/** `name` as a whole number of milliseconds, or `undefined` when unset or empty. */
function msFromEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim() ?? '';
  if (raw === '') return undefined;
  const ms = Number(raw);
  if (!Number.isSafeInteger(ms) || ms < 0) {
    throw new RangeError(`${name} must be a whole number of milliseconds >= 0, got ${raw}`);
  }
  return ms;
}

function options(): CreateServerOpts<SandboxInput> {
  const db = process.env['SANDBOX_DB']?.trim() ?? '';
  return {
    port: PORT,
    devAuth: true,
    // The server owns the store: close() saves into it, then closes it.
    store: db === '' ? undefined : new SqliteStore(resolve(db)),
    reconnectGraceMs: msFromEnv('SANDBOX_RECONNECT_GRACE_MS'),
    regionLoader: new SandboxLoader(),
    hooks: createHooks(),
  };
}

let opts: CreateServerOpts<SandboxInput>;
try {
  opts = options();
} catch (err) {
  // A bad variable, or node:sqlite missing (its message says which Node version or flag to use).
  console.error(`sandbox server: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
const server = await createServer(game, opts);
const file = opts.store instanceof SqliteStore ? opts.store.path : null;
const store = file ?? 'memory (SANDBOX_DB unset)';
const grace =
  opts.reconnectGraceMs === undefined ? '' : `; reconnect grace ${opts.reconnectGraceMs} ms`;

// eslint-disable-next-line no-console -- dev boot message (`pnpm dev` waits for it)
console.info(`listening on ${server.url} (store: ${store}${grace})`);

let closing = false;
function shutdown(signal: NodeJS.Signals): void {
  // `tsx watch` relays the terminal's SIGINT, so a Ctrl-C arrives twice; the first one closes.
  if (closing) return;
  closing = true;
  // eslint-disable-next-line no-console -- dev shutdown message
  console.info(`${signal}: closing the sandbox server`);
  server.close().then(
    () => {
      // eslint-disable-next-line no-console -- dev shutdown message
      console.info(`sandbox server closed${file === null ? '' : `; session saved to ${file}`}`);
      process.exit(0);
    },
    (err: unknown) => {
      console.error('sandbox server close failed', err);
      process.exit(1);
    },
  );
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

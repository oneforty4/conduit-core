import { conduitVite } from '@conduit/tooling/vite';
import { defineConfig, type ProxyOptions } from 'vite';

/**
 * The host's routes (docs/host.md 10, 17, 22): the lobby API, the presence and game sockets, and
 * `/healthz`. Host mode forwards them, WebSocket upgrades included, so the page, its login cookie and
 * the `wsUrl` the lobby derives from the `Host` header all stay on vite's origin.
 */
const HOST_PATHS = ['auth', 'me', 'games', 'sessions', 'friends', 'lobby', 'session', 'healthz'];

/** Whole path segments only: `/session/<id>` and `/sessions`, but not `/sessionsomething`. */
function hostProxy(target: string): Record<string, ProxyOptions> {
  return Object.fromEntries(
    HOST_PATHS.map((path) => [`^/${path}(?:[/?]|$)`, { target, ws: true }]),
  );
}

/** A port from the environment, or `undefined` when the variable is unset or empty. */
function portFromEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim() ?? '';
  if (raw === '') return undefined;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RangeError(`${name} must be a port number, got ${raw}`);
  }
  return port;
}

// `pnpm dev`: the dev server on 5173, the page connects to the game server on 8081 itself.
// `pnpm dev:host` (`vite --mode host`): the lobby menu, with the host's routes proxied to
// http://localhost:$PORT (default 8080, the port the host CLI reads too). SANDBOX_VITE_PORT moves
// vite (the e2e smoke run uses it) and then insists on that port. Its optimized dependencies live
// in a cache of their own, so a `pnpm dev` running at the same time (as `pnpm e2e` runs both) never
// re-optimizes into the directory this server is serving from.
export default defineConfig(({ mode }) => {
  if (mode !== 'host') return conduitVite();
  const vitePort = portFromEnv('SANDBOX_VITE_PORT');
  const hostPort = portFromEnv('PORT') ?? 8080;
  return conduitVite({
    cacheDir: 'node_modules/.vite-host',
    server: {
      port: vitePort ?? 5173,
      strictPort: vitePort !== undefined,
      proxy: hostProxy(`http://localhost:${hostPort}`),
    },
  });
});

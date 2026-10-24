// `pnpm e2e` defaults to headless Chromium; CONDUIT_BROWSER selects Firefox or WebKit.
// Chromium uses SwiftShader so it runs without a GPU (CI). Two dev servers:
// `chromium` runs render-memory.spec.ts against `pnpm dev`, `smoke` runs smoke.spec.ts against
// `pnpm dev:host` (the lobby menu, the host and its session workers).
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/** `pnpm dev`: Vite's dev server; the page connects to the game server on ws://localhost:8081 itself. */
const DEV_URL = 'http://localhost:5173';
/**
 * `pnpm dev:host` for the smoke test, on ports of its own (vite's `SANDBOX_VITE_PORT`, the host's
 * `PORT`, which vite's proxy follows), so it runs next to `pnpm dev` and does not meet a developer's
 * own `pnpm dev:host` on 5173 and 8080.
 */
const SMOKE_VITE_PORT = 5174;
const SMOKE_HOST_PORT = 8090;
const SMOKE_URL = `http://localhost:${SMOKE_VITE_PORT}`;
/** A fixed test secret (48 bytes): tokens it signs only ever reach the test's own host. */
const SMOKE_HOST_SECRET = 'sandbox-e2e-smoke-host-secret-0123456789abcdefgh';
/** A new SQLite file per run (the host creates it), so the lobby starts without accounts. */
const SMOKE_DB_PATH = join(tmpdir(), `conduit-sandbox-smoke-${Date.now()}-${process.pid}.sqlite`);
const CI = process.env['CI'] !== undefined && process.env['CI'] !== '';
const browser = process.env['CONDUIT_BROWSER'] ?? 'chromium';
if (!['chromium', 'firefox', 'webkit'].includes(browser))
  throw new Error(`Unsupported CONDUIT_BROWSER: ${browser}`);

const chromium = {
  ...devices['Desktop Chrome'],
  launchOptions: { args: ['--use-gl=angle', '--use-angle=swiftshader'] },
};
const browserOptions =
  browser === 'firefox'
    ? devices['Desktop Firefox']
    : browser === 'webkit'
      ? devices['Desktop Safari']
      : chromium;

export default defineConfig({
  testDir: 'e2e',
  // One dev server per project and one game session per spec: tests run one at a time.
  workers: 1,
  fullyParallel: false,
  forbidOnly: CI,
  retries: 0,
  timeout: 180_000,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: browser,
      testMatch:
        browser === 'chromium'
          ? /(?:render-memory|suspend-resume)\.spec\.ts$/
          : /render-memory\.spec\.ts$/,
      use: { ...browserOptions, baseURL: DEV_URL },
    },
    {
      name: 'smoke',
      testMatch: /smoke\.spec\.ts$/,
      use: { ...browserOptions, baseURL: SMOKE_URL },
    },
  ],
  // Started one after the other, each reused when already running (always fresh under `CI`).
  webServer: [
    {
      // Builds the assets, then starts vite and the game server. Playwright waits for vite only;
      // render-memory.spec.ts waits for the game server's port (e2e/sandbox.ts).
      command: 'pnpm dev',
      url: DEV_URL,
      reuseExistingServer: !CI,
      timeout: 180_000,
      stdout: 'pipe',
      stderr: 'pipe',
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
    },
    {
      // Vite in host mode and the conduit-host CLI. `/healthz` through vite's proxy answers once
      // both are up.
      command: 'pnpm dev:host',
      url: `${SMOKE_URL}/healthz`,
      env: {
        HOST_SECRET: SMOKE_HOST_SECRET,
        DB_PATH: SMOKE_DB_PATH,
        PORT: String(SMOKE_HOST_PORT),
        SANDBOX_VITE_PORT: String(SMOKE_VITE_PORT),
      },
      reuseExistingServer: !CI,
      timeout: 180_000,
      stdout: 'pipe',
      stderr: 'pipe',
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
    },
  ],
});

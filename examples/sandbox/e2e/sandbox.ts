// Shared e2e helpers (not a spec: Playwright runs `*.spec.ts`).
import { connect } from 'node:net';
import { expect, type Page } from '@playwright/test';

/** The game server `pnpm dev` starts (src/server/main.ts). */
export const GAME_SERVER = { host: '127.0.0.1', port: 8081 } as const;

/** Resolves once `host:port` accepts TCP connections; rejects after `timeoutMs`. */
export async function waitForPort(
  { host, port }: { host: string; port: number },
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = connect({ host, port });
      socket.once('connect', () => {
        socket.end();
        resolve(true);
      });
      socket.once('error', () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (open) return;
    if (Date.now() > deadline)
      throw new Error(`${host}:${port} did not open within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** A console error or uncaught exception of a page; `url` is where the console placed it. */
export interface PageError {
  text: string;
  url: string;
}

/** Page console errors (with their location) and uncaught exceptions, from now on. */
export function collectPageErrors(page: Page): PageError[] {
  const errors: PageError[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push({ text: msg.text(), url: msg.location().url });
  });
  page.on('pageerror', (err) => errors.push({ text: `${err.name}: ${err.message}`, url: '' }));
  return errors;
}

/** Page console errors and uncaught exceptions, from now on. */
export function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(`${err.name}: ${err.message}`));
  return errors;
}

/**
 * Opens the sandbox as `name` once the game server listens, and waits for `__conduit.ready` (own
 * vehicle spawned, one frame rendered). Retried while the page is replaced under it, as when Vite
 * reloads after optimizing a dependency it discovered on the first load.
 */
export async function openSandbox(page: Page, name: string): Promise<void> {
  await waitForPort(GAME_SERVER, 60_000);
  await page.goto(`/?name=${encodeURIComponent(name)}`);
  await expect(async () => {
    await page.waitForFunction(() => window.__conduit !== undefined, undefined, {
      timeout: 30_000,
    });
    await page.evaluate(() => window.__conduit?.ready);
  }).toPass({ timeout: 120_000 });
}

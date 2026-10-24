// The host path end to end (CONCEPT.md Verification, PLAN.md M5), against `pnpm dev:host`: two
// browser contexts (two cookie jars) register two accounts through the lobby menu, A creates a
// private session and plays, B joins it by session id and invite code, and `W` held in A moves A's
// vehicle in B's replica. Neither page may log a console error beyond the explicit list below.
import { expect, type Page, test } from '@playwright/test';
import { collectPageErrors, type PageError } from './sandbox.ts';

const PASSWORD = 'smoke-password-1';

/** A console error the flow causes on purpose: a non-2xx response the page fetched. */
interface ResourceError {
  status: number;
  path: string;
}

/**
 * Chrome reports every non-2xx response a page fetched as a console error (`Failed to load
 * resource: the server responded with a status of 401 (Unauthorized)`). The menu's first `GET /me`
 * answers 401 before anyone logged in (menu.ts `start()`); that is the only one each page causes.
 */
const EXPECTED_RESOURCE_ERRORS: readonly ResourceError[] = [{ status: 401, path: '/me' }];
const RESOURCE_STATUS = /^Failed to load resource: the server responded with a status of (\d{3})\b/;

/** Splits a page's errors into the expected resource errors and everything else. */
function sortErrors(errors: readonly PageError[]): {
  expected: ResourceError[];
  unexpected: PageError[];
} {
  const expected: ResourceError[] = [];
  const unexpected: PageError[] = [];
  for (const error of errors) {
    const status = Number(RESOURCE_STATUS.exec(error.text)?.[1]);
    const path = error.url === '' ? '' : new URL(error.url).pathname;
    const match = EXPECTED_RESOURCE_ERRORS.find((e) => e.status === status && e.path === path);
    if (match === undefined) unexpected.push(error);
    else expected.push({ status, path });
  }
  return { expected, unexpected };
}

/** Registers (the menu then logs in) and waits for the signed-in view. */
async function register(page: Page, username: string, displayName: string): Promise<void> {
  await page.goto('/');
  const form = page.locator('#register');
  await expect(form).toBeVisible({ timeout: 60_000 });
  await form.locator('[name=username]').fill(username);
  await form.locator('[name=password]').fill(PASSWORD);
  await form.locator('[name=displayName]').fill(displayName);
  await form.locator('button[type=submit]').click();
  await expect(page.locator('#menu-signed-in')).toBeVisible();
  await expect(page.locator('#menu-account')).toHaveText(`${displayName} (${username})`);
}

/** Resolves once the page's game client spawned and rendered a frame (`window.__conduit.ready`). */
async function playing(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__conduit !== undefined, undefined, { timeout: 60_000 });
  await page.evaluate(() => window.__conduit?.ready);
  expect(await page.evaluate(() => window.__conduit?.state())).toBe('spawned');
}

/** Where the page's replica has the vehicle named `name` (the account's display name), if any. */
function vehiclePosition(page: Page, name: string): Promise<{ x: number; z: number } | null> {
  return page.evaluate((who) => {
    const client = window.__conduit?.client;
    if (client === undefined || client.state !== 'spawned') return null;
    const transform = client.game.component('Transform');
    const label = client.game.component('Name');
    if (transform === undefined || label === undefined) return null;
    for (const entity of client.replica.entities()) {
      if (entity.destroyedTick !== null) continue;
      const named = client.replica.read(entity.id, label) as { value: string } | undefined;
      if (named?.value !== who) continue;
      const at = client.replica.read(entity.id, transform) as
        { pos: { x: number; z: number } } | undefined;
      return at === undefined ? null : { x: at.pos.x, z: at.pos.z };
    }
    return null;
  }, name);
}

test('two accounts create and join a session through the lobby menu; W in A moves A on B', async ({
  page: pageA,
  browser,
  baseURL,
  viewport,
}) => {
  const contextB = await browser.newContext({
    ...(baseURL === undefined ? {} : { baseURL }),
    viewport,
  });
  const pageB = await contextB.newPage();
  const errors = { A: collectPageErrors(pageA), B: collectPageErrors(pageB) };
  const resources: Record<'A' | 'B', ResourceError[]> = { A: [], B: [] };
  for (const [label, page] of [
    ['A', pageA],
    ['B', pageB],
  ] as const)
    page.on('response', (response) => {
      const entry = { status: response.status(), path: new URL(response.url()).pathname };
      if (
        EXPECTED_RESOURCE_ERRORS.some(
          (expected) => expected.status === entry.status && expected.path === entry.path,
        )
      )
        resources[label].push(entry);
    });
  const run = Date.now().toString(36);
  const nameA = 'Smoke A';

  try {
    await register(pageA, `smoke_a_${run}`, nameA);
    await register(pageB, `smoke_b_${run}`, 'Smoke B');

    // A creates a private session: the list shows it with its id and invite code, and A plays.
    const create = pageA.locator('#create');
    await create.locator('[name=name]').fill(`smoke ${run}`);
    await create.locator('[name=visibility]').selectOption('private');
    await create.locator('[name=maxPlayers]').fill('2');
    await create.locator('button[type=submit]').click();
    const entry = pageA.locator('#sessions li[data-invite-code]');
    await expect(entry).toHaveCount(1);
    const sessionId = (await entry.getAttribute('data-session-id')) ?? '';
    const inviteCode = (await entry.getAttribute('data-invite-code')) ?? '';
    expect(inviteCode).toMatch(/^[0-9BCDFGHJKMNPQRSTVWXZ]{8}$/);
    await entry.getByRole('button', { name: 'Play' }).click();
    await playing(pageA);
    await expect(pageA.locator('#invite')).toHaveAttribute('data-invite-code', inviteCode);

    // B does not see the private session, even after a refresh; it joins with the id and the code.
    await pageB.locator('#refresh').click();
    await expect(pageB.locator('#menu')).toHaveAttribute('aria-busy', 'false');
    await expect(pageB.locator(`#sessions li[data-session-id="${sessionId}"]`)).toHaveCount(0);
    const join = pageB.locator('#join');
    await join.locator('[name=session]').fill(sessionId);
    await join.locator('[name=code]').fill(inviteCode.toLowerCase());
    await join.locator('button[type=submit]').click();
    await playing(pageB);

    // A's vehicle is in B's replica; W held in A moves it there.
    await expect.poll(() => vehiclePosition(pageB, nameA), { timeout: 30_000 }).not.toBeNull();
    const start = await vehiclePosition(pageB, nameA);
    if (start === null) throw new Error("A's vehicle left B's replica");
    await pageA.keyboard.down('KeyW');
    await expect
      .poll(
        async () => {
          const at = await vehiclePosition(pageB, nameA);
          return at === null ? 0 : Math.hypot(at.x - start.x, at.z - start.z);
        },
        { timeout: 30_000 },
      )
      .toBeGreaterThan(1);
    await pageA.keyboard.up('KeyW');

    for (const [label, page] of [
      ['A', pageA],
      ['B', pageB],
    ] as const) {
      expect(await page.evaluate(() => window.__conduit?.state()), label).toBe('spawned');
    }
  } catch (err) {
    // The page fixture (A) gets the configured screenshot and trace; B is attached by hand.
    const shot = await pageB.screenshot().catch(() => null);
    if (shot !== null) await test.info().attach('page B', { body: shot, contentType: 'image/png' });
    throw err;
  } finally {
    await contextB.close();
  }

  // Browser console formatting differs; require the HTTP response and reject unrelated console errors.
  for (const label of ['A', 'B'] as const) {
    const { unexpected } = sortErrors(errors[label]);
    expect(unexpected, `page ${label}: unexpected console errors`).toEqual([]);
    expect(resources[label], `page ${label}: expected HTTP responses`).toEqual(
      EXPECTED_RESOURCE_ERRORS,
    );
  }
});

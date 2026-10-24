// Forced Chromium debugger suspension exercises stopped JS dispatch and queued network recovery.
// It does not claim to reproduce a physical hidden tab's browser-specific throttling policy.
import { expect, test, type Page } from '@playwright/test';
import { collectErrors, openSandbox } from './sandbox.ts';

declare global {
  interface Window {
    __suspendProbe?: {
      timerPulses: number;
      lastAppliedInput: number;
      snapshotTick: number;
      timer: number;
    };
  }
}
// Keep debugger suspension free of concurrent trace DOM evaluation.
test.use({ trace: 'off' });

async function probe(page: Page) {
  return page.evaluate(() => {
    const debug = window.__conduit,
      probe = window.__suspendProbe;
    if (debug === undefined || probe === undefined)
      throw new Error('Suspension probe is not ready');
    const stats = debug.client.net.stats();
    const vehicle = debug.client.game.component('Vehicle');
    const entity = debug.client.localEntity;
    const value =
      vehicle === undefined || entity === undefined
        ? undefined
        : (debug.client.replica.read(entity, vehicle) as { throttle: number } | undefined);
    return {
      state: debug.state(),
      timerPulses: probe.timerPulses,
      visibility: document.visibilityState,
      lastAppliedInput: probe.lastAppliedInput,
      snapshotTick: probe.snapshotTick,
      snapshots: stats.snapshots,
      lead: debug.client.clock.inputLead,
      inputTick: debug.client.clock.inputTick(),
      serverTick: debug.client.clock.serverTickNow(),
      throttle: value?.throttle ?? null,
      position: debug.localPosition(),
    };
  });
}

test('forced debugger suspension resumes input and queued snapshots without growing input lead', async ({
  page,
  browserName,
  context,
  browser,
}, testInfo) => {
  test.skip(
    browserName !== 'chromium',
    'Chromium CDP debugger API only; other projects match memory/smoke without this spec.',
  );
  const errors = collectErrors(page);
  await openSandbox(page, 'e2e-suspend-resume');
  await page.evaluate(() => {
    const debug = window.__conduit!;
    const probe = {
      timerPulses: 0,
      lastAppliedInput: 0,
      snapshotTick: 0,
      timer: 0,
    };
    probe.timer = window.setInterval(() => {
      probe.timerPulses++;
    }, 20);
    debug.client.net.on('snapshot', (header) => {
      probe.lastAppliedInput = header.lastInputTick;
      probe.snapshotTick = header.serverTick;
    });
    window.__suspendProbe = probe;
  });
  await expect.poll(async () => (await probe(page)).lastAppliedInput).toBeGreaterThan(0);
  const before = await probe(page);
  const cdp = await context.newCDPSession(page);
  let paused = false;
  try {
    await cdp.send('Debugger.enable');
    const acknowledged = new Promise<void>((resolve) =>
      cdp.once('Debugger.paused', () => resolve()),
    );
    await cdp.send('Debugger.pause');
    await acknowledged;
    paused = true;
    const suspendedAt = Date.now();
    // This wait is on the Playwright driver, not a timer in the suspended page.
    await new Promise((resolve) => setTimeout(resolve, 2500));
    await cdp.send('Debugger.resume');
    paused = false;
    const suspendedMs = Date.now() - suspendedAt;
    expect(suspendedMs).toBeGreaterThanOrEqual(2500);
    const immediate = await probe(page);
    expect(immediate.timerPulses - before.timerPulses).toBeLessThan(15);
    await expect
      .poll(async () => (await probe(page)).snapshotTick, { timeout: 15_000 })
      .toBeGreaterThan(before.snapshotTick + 60);
    await expect
      .poll(async () => (await probe(page)).lastAppliedInput, { timeout: 15_000 })
      .toBeGreaterThan(before.lastAppliedInput + 30);
    const resumed = await probe(page);
    expect(resumed.state).toBe('spawned');
    expect(resumed.snapshots).toBeGreaterThan(before.snapshots);
    expect(resumed.lead).toBeLessThanOrEqual(32);
    expect(resumed.inputTick - resumed.serverTick).toBeLessThanOrEqual(33);
    // A fresh low-latency Pong must replace the stalled sample, rather than growing lead forever.
    await expect
      .poll(async () => (await probe(page)).lead, { timeout: 15_000 })
      .toBeLessThanOrEqual(Math.max(8, before.lead + 4));
    await page.locator('canvas').click();
    const position = (await probe(page)).position;
    expect(position).not.toBeNull();
    await page.keyboard.down('KeyW');
    await expect.poll(async () => (await probe(page)).throttle, { timeout: 10_000 }).toBe(127);
    await expect
      .poll(
        async () => {
          const next = (await probe(page)).position;
          return next === null || position === null
            ? 0
            : Math.hypot(next.x - position.x, next.z - position.z);
        },
        { timeout: 10_000 },
      )
      .toBeGreaterThan(0.25);
    await page.keyboard.up('KeyW');
    await expect.poll(async () => (await probe(page)).throttle, { timeout: 10_000 }).toBe(0);
    const after = await probe(page);
    expect(after.state).toBe('spawned');
    expect(after.lead).toBeLessThanOrEqual(Math.max(8, before.lead + 4));
    expect(errors).toEqual([]);
    await testInfo.attach('forced-debugger-suspension.json', {
      contentType: 'application/json',
      body: JSON.stringify(
        {
          scope:
            'forced Chromium main-thread debugger suspension; not lifecycle freezing or physical hidden-tab throttling and no transport reconnect injected',
          browser: browser.version(),
          suspendedMs,
          before,
          immediate,
          resumed,
          after,
        },
        null,
        2,
      ),
    });
  } finally {
    if (paused) await cdp.send('Debugger.resume').catch(() => {});
    await page.keyboard.up('KeyW').catch(() => {});
    await page
      .evaluate(() => {
        if (window.__suspendProbe !== undefined) window.clearInterval(window.__suspendProbe.timer);
      })
      .catch(() => {});
    await cdp.detach();
  }
});

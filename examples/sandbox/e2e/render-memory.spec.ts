// docs/render.md 10.3: streaming a region's assets in and out leaves renderer memory where it was.
import { expect, test, type Page } from '@playwright/test';
import { collectErrors, openSandbox } from './sandbox.ts';

/**
 * A region far from the spawn cell (`cell/8_8`): not in the client's region set, so no view is ever
 * in its group and `releaseRegionGroup` really removes the group.
 */
const REGION = 'cell/0_0';
const CYCLES = 50;

interface MemoryProbe {
  geometries: number;
  textures: number;
  /** The region group's assets in the client's loader. */
  assets: { id: string; state: string; refcount: number }[];
  hasGroup: boolean;
}

function probe(page: Page): Promise<MemoryProbe> {
  return page.evaluate((region) => {
    const d = window.__conduit;
    if (d?.host === undefined || d.world === undefined || d.assets === undefined) {
      throw new Error('__conduit is not rendering with an asset loader');
    }
    const { geometries, textures } = d.host.renderer.info.memory;
    const loader = d.assets;
    const ids = loader.manifest.regions[region] ?? [];
    return {
      geometries,
      textures,
      assets: ids.map((id) => ({ id, state: loader.state(id), refcount: loader.refcount(id) })),
      hasGroup: d.world.hasRegionGroup(region),
    };
  }, REGION);
}

test(`acquiring and releasing the ${REGION} asset group ${CYCLES} times returns renderer memory to its baseline`, async ({
  page,
}) => {
  const errors = collectErrors(page);
  await openSandbox(page, 'e2e-render-memory');

  // Settle: every held region loaded and every view showing its model, not a placeholder.
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const d = window.__conduit;
          if (d?.world === undefined) return false;
          const views = [...d.world.views()];
          return (
            d.client.regions.loading().length === 0 &&
            views.length > 0 &&
            views.every((v) => v.model !== undefined)
          );
        }),
      { timeout: 60_000 },
    )
    .toBe(true);

  const setup = await page.evaluate((region) => {
    const d = window.__conduit;
    if (d?.host === undefined || d.world === undefined || d.manifest === undefined) {
      throw new Error('__conduit is not rendering with a manifest');
    }
    // Pause the frame loop: wanderers walking into view or to another level of detail upload
    // geometry the test did not cause, and a rendered frame would re-upload anything the loader
    // disposed while a view still used it, hiding exactly the release bug this test looks for.
    d.host.stop();
    const views = [...d.world.views()];
    return {
      assets: d.manifest.regions[region] ?? [],
      held: d.regionsLoaded().includes(region),
      viewsInRegion: views.filter((v) => v.regionId === region).length,
      frame: d.host.frame,
    };
  }, REGION);
  expect(setup.assets.length).toBeGreaterThan(0);
  expect(setup.held).toBe(false);
  expect(setup.viewsInRegion).toBe(0);
  // Graces armed before the test (say, by a view that went away) expire now, not inside the loop.
  await page.evaluate(() => window.__conduit?.debug.expireGrace());

  const baseline = await probe(page);
  expect(baseline.hasGroup).toBe(false);
  expect(baseline.geometries).toBeGreaterThan(0);

  for (let i = 0; i < CYCLES; i++) {
    const cycle = await page.evaluate(async (region) => {
      const d = window.__conduit;
      if (d?.world === undefined || d.assets === undefined || d.manifest === undefined) {
        throw new Error('__conduit is not rendering with an asset loader');
      }
      const handle = await d.assets.acquireGroup(d.manifest.regions[region] ?? []);
      d.world.regionGroup(region);
      const grouped = d.world.hasRegionGroup(region);
      handle.release();
      d.world.releaseRegionGroup(region);
      const released = !d.world.hasRegionGroup(region);
      await d.debug.expireGrace();
      return { members: handle.handles.length, grouped, released };
    }, REGION);
    expect(cycle, `cycle ${i}`).toEqual({
      members: setup.assets.length,
      grouped: true,
      released: true,
    });
  }

  expect(await probe(page)).toEqual(baseline);

  // The frame loop picks up where it stopped.
  const frame = await page.evaluate(() => {
    const host = window.__conduit?.host;
    host?.start();
    return host?.frame ?? -1;
  });
  expect(frame).toBe(setup.frame);
  await expect
    .poll(() => page.evaluate(() => window.__conduit?.host?.frame ?? -1), { timeout: 30_000 })
    .toBeGreaterThan(frame + 10);
  expect(errors).toEqual([]);
});

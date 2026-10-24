import { build } from '../../packages/game/node_modules/esbuild/lib/main.js';
import { chromium } from '../../examples/sandbox/node_modules/@playwright/test/index.mjs';
await import('../fixtures/exact-runtime-contract.mjs');
const nodeResult = globalThis.exactRuntimeContract;
const bundled = await build({
  entryPoints: ['scripts/fixtures/exact-runtime-contract.mjs'],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  write: false,
});
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CONDUIT_CHROMIUM_PATH
    ? { executablePath: process.env.CONDUIT_CHROMIUM_PATH }
    : {}),
});
try {
  const page = await browser.newPage();
  await page.addScriptTag({ content: bundled.outputFiles[0].text });
  const browserResult = await page.evaluate(() => globalThis.exactRuntimeContract);
  const equal = JSON.stringify(nodeResult) === JSON.stringify(browserResult);
  console.log(
    JSON.stringify(
      {
        contract:
          'exact tagged codec + integer RNG only; arbitrary game math needs its own tolerance contract',
        node: process.version,
        chromium: browser.version(),
        equal,
        rngState: nodeResult.state,
        bytes: nodeResult.exactHex.length / 2,
      },
      null,
      2,
    ),
  );
  if (!equal) process.exitCode = 1;
} finally {
  await browser.close();
}

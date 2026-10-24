// Node file I/O stays in tooling; three-specific accounting stays inside @conduit/render.
import { readFile } from 'node:fs/promises';
import { measureAssetOwnership } from '../../packages/render/bin/measure-asset-ownership.mjs';
const sources = await Promise.all(
  ['crate', 'vehicle'].map(async (name) => ({
    name,
    raw: await readFile(`examples/sandbox/assets/${name}.glb`),
  })),
);
console.log(JSON.stringify(await measureAssetOwnership(sources), null, 2));

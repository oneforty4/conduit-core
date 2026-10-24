// `pnpm world`: writes world.json, the sandbox's world graph (`game.graphJson()`, docs/world.md 1),
// which `pnpm assets` hands to `conduit-assets build --graph` to fill the manifest's per-region asset
// lists (docs/assets.md 2.1). Run it after changing the world in src/shared/game.ts and commit the
// result; test/game.test.ts fails while world.json is stale.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { game } from '../src/shared/game.ts';

const out = fileURLToPath(new URL('../world.json', import.meta.url));
const graph = game.graphJson();
writeFileSync(out, `${JSON.stringify(graph, null, 2)}\n`);
process.stdout.write(`wrote ${graph.regions.length} regions to ${out}\n`);

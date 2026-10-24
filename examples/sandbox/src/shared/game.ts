import { defineGame, GridWorld } from '@conduit/game';
import { Crate, Vehicle, Wanderer } from './components.ts';
import { CELL_SIZE, GRID_COLS, GRID_ROWS } from './constants.ts';
import { Horn } from './events.ts';
import { InputFrame } from './input.ts';
import { Chat, Joins } from './messages.ts';
import { vehicleInput, vehicleKinematics, wandererAi } from './systems.ts';

/**
 * The sandbox reference game (PLAN.md "Sandbox content spec"). Imported by the server entries, the
 * browser client and `packages/game/test/headless.test.ts`.
 *
 * It has no `assets`: the manifest is generated (`pnpm assets` writes the gitignored
 * `public/assets/manifest.json`), so the browser client fetches it at startup and passes it to
 * `createClient` as `manifest`, and a checkout without generated files still typechecks and tests.
 */
export const game = defineGame({
  id: 'sandbox',
  name: 'Sandbox',
  protocolVersion: 1,
  tickRate: 60,
  snapshotEvery: 3,
  seed: 0xc0ffee,
  components: [Vehicle, Wanderer, Crate],
  messages: [Chat, Joins],
  events: [Horn],
  input: InputFrame,
  systems: [vehicleInput, vehicleKinematics, wandererAi],
  world: (seed) =>
    new GridWorld({
      cellSize: CELL_SIZE,
      cols: GRID_COLS,
      rows: GRID_ROWS,
      plane: 'xz',
      kind: 'cell',
      wantedDepth: 1,
      worldSeed: seed,
      assetsFor: () => ['crate'],
    }),
});

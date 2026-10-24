// Sandbox tuning (PLAN.md "Sandbox content spec"). Shared by the systems, the server and the client.

/** Vehicle speed at full throttle, m/s. */
export const MAX_SPEED = 20;
/** Vehicle yaw rate at full steer, rad/s. */
export const TURN_RATE = 1.5;
/** A full `throttle`/`steer` input: `-INPUT_MAX..INPUT_MAX` maps to `-1..1`. */
export const INPUT_MAX = 127;

/** The world: `GRID_COLS` x `GRID_ROWS` cells of `CELL_SIZE` metres on the xz plane. */
export const CELL_SIZE = 256;
export const GRID_COLS = 16;
export const GRID_ROWS = 16;

/** Every player spawns here; the cell's world origin is (2048, 0, 2048). */
export const SPAWN_REGION = 'cell/8_8';
/** A player's vehicle spawns at local `(SPAWN_SPACING * playerId, 0, 0)` so vehicles do not overlap. */
export const SPAWN_SPACING = 2;

/** Crates `SandboxLoader` places in each fresh region. */
export const CRATES_PER_REGION = 8;
/** Crates and wanderer targets lie in `[PLACE_MIN, PLACE_MAX)` on local x and z. */
export const PLACE_MIN = 8;
export const PLACE_MAX = 248;
/** A region's wanderer starts at local `(WANDERER_START, 0, WANDERER_START)`, the cell centre. */
export const WANDERER_START = 128;
/** Wanderer speed, m/s. */
export const WANDERER_SPEED = 4;
/** A wanderer this close to its target (m) picks a new one. */
export const WANDERER_ARRIVE_RADIUS = 1;

/** Vehicle colours (0xRRGGBB) by `playerId % 8`; none is the magenta of the placeholder boxes. */
export const COLOURS: readonly number[] = Object.freeze([
  0xe6194b, 0x3cb44b, 0xffe119, 0x4363d8, 0xf58231, 0x42d4f4, 0xbfef45, 0xfabed4,
]);

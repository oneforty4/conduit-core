import { defineComponent, f } from '@conduit/game';

/**
 * A player's vehicle: the input it last received (`buttons` is the previous tick's bits, which is
 * what makes the horn a rising edge) and its tint (`0xRRGGBB`). Positions live in `Transform`.
 */
export const Vehicle = defineComponent(
  'Vehicle',
  { throttle: f.i8, steer: f.i8, buttons: f.u32, colour: f.u32 },
  { replicate: true, persist: false },
);

/** Server-only AI state of a region's wanderer: a region-local target and a speed in m/s. */
export const Wanderer = defineComponent(
  'Wanderer',
  { target: f.vec3(f.fixed32(0.001)), speed: f.fixed16(0.01) },
  { replicate: false, persist: true },
);

/** Tag of the static crates `SandboxLoader` scatters over each region. */
export const Crate = defineComponent('Crate', {}, { replicate: true, persist: true });

export type VehicleValue = ReturnType<typeof Vehicle.create>;

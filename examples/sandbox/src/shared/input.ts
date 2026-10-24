import { defineInput, f } from '@conduit/game';

/**
 * One client tick of player input. `throttle` and `steer` are `-127..127` (`INPUT_MAX`), mapped to
 * `-1..1`: positive throttle drives forward, positive steer turns right.
 */
export const InputFrame = defineInput({ tick: f.u32, throttle: f.i8, steer: f.i8, buttons: f.u32 });

export type SandboxInput = ReturnType<typeof InputFrame.create>;

/** `buttons` bits. */
export const BUTTON_HORN = 1 << 0;
/** Reserved; always zero in v1. */
export const BUTTON_BRAKE = 1 << 1;

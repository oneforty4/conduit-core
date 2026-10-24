import { defineEvent, f } from '@conduit/game';

/**
 * A vehicle sounded its horn (PLAN.md "Sandbox content spec"). `vehicleInput` emits it in the
 * vehicle's region on the `BUTTON_HORN` rising edge; it replicates to the clients whose interest
 * includes that region, which flash the HUD when their render tick reaches the event's tick.
 */
export const Horn = defineEvent('Horn', { entity: f.entity() }, { replicate: true });

export type HornEvent = ReturnType<typeof Horn.create>;

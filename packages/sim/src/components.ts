import { f } from '@conduit/protocol';
import { defineComponent } from './component.ts';

/**
 * Region-local position (docs/world.md 4), rotation and velocity. `fixed32(0.001)` gives
 * +-2 147 483 m per axis. The velocity is `f32`, m/s, with no cap: as `fixed16(0.01)` it stopped
 * at +-327.67 m/s per axis, short of a supersonic aircraft, and no component of a game's own can
 * stand in for it (`extrapolateWith` and every reader of this one use this `vel`).
 */
export const Transform = defineComponent(
  'Transform',
  { pos: f.vec3(f.fixed32(0.001)), rot: f.quat(), vel: f.vec3(f.f32) },
  { replicate: true, persist: true, interpolate: ['pos', 'rot'], extrapolateWith: 'vel' },
);

/** The region an entity belongs to; re-derived from the blob it is stored in, so not persisted. */
export const Region = defineComponent(
  'Region',
  { id: f.str(64) },
  { replicate: true, persist: false },
);

export const Model = defineComponent(
  'Model',
  { asset: f.str(64), variant: f.u8 },
  { replicate: true, persist: true },
);

/** Marks player-owned entities; players are never written into region blobs. */
export const Owner = defineComponent(
  'Owner',
  { player: f.u8 },
  { replicate: true, persist: false },
);

export const Name = defineComponent(
  'Name',
  { value: f.str(32) },
  { replicate: true, persist: true },
);

export const CORE_COMPONENTS = [Transform, Region, Model, Owner, Name] as const;

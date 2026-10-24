import {
  defineInput,
  f,
  type InputFrameBase,
  type Schema,
  SchemaRegistry,
} from '@conduit/protocol';
import type { ComponentType, EventType, RegionsApi, SpatialApi } from '../src/index.ts';

export const TestInput = defineInput({ tick: f.u32 });

/** A registry over sim component/event types, as `defineGame` would build (minus validation). */
export function registryOf(
  components: readonly ComponentType<unknown>[],
  events: readonly EventType<unknown>[] = [],
  input: Schema<InputFrameBase> = TestInput,
): SchemaRegistry {
  return new SchemaRegistry({ components, messages: [], events, input });
}

export const noRegions: RegionsApi = {
  regionOf: () => undefined,
  entitiesIn: () => [],
  active: () => [],
  def: () => undefined,
  migrate: () => 'notMember',
};

export const noSpatial: SpatialApi = {
  queryRadius: (_id, _pos, _r, out) => out,
  queryAABB: (_id, _min, _max, out) => out,
  queryRadiusAcross: (_id, _pos, _r, out) => out,
  nearest: () => undefined,
};

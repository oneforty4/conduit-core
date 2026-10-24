import {
  type InputFrameBase,
  type MessageDef,
  type Schema,
  SchemaRegistry,
} from '@conduit/protocol';
import type { ComponentType, EventType } from '@conduit/sim';
import { stringCompare } from '@conduit/world';

/** The lists and input schema a game registry is built from (unsorted; the registry sorts). */
export interface GameRegistryParts {
  components: readonly ComponentType<unknown>[];
  messages: readonly MessageDef<unknown>[];
  events: readonly EventType<unknown>[];
  input: Schema<InputFrameBase>;
}

/** The lists sorted by name, as `Game` exposes them. */
export interface AssignedIds {
  components: readonly ComponentType<unknown>[];
  messages: readonly MessageDef<unknown>[];
  events: readonly EventType<unknown>[];
}

/** `new SchemaRegistry(parts)` (docs/protocol.md 7): ids and kinds from sorted names, plus the hash. */
export function buildGameRegistry(parts: GameRegistryParts): SchemaRegistry {
  return new SchemaRegistry({
    components: parts.components,
    messages: parts.messages,
    events: parts.events,
    input: parts.input,
  });
}

function byName(a: { readonly name: string }, b: { readonly name: string }): number {
  return stringCompare(a.name, b.name);
}

/** Sorts registry definitions without mutating them. IDs are resolved through SchemaRegistry. */
export function assignIds(
  components: readonly ComponentType<unknown>[],
  messages: readonly MessageDef<unknown>[],
  events: readonly EventType<unknown>[],
): AssignedIds {
  const sortedComponents = [...components].sort(byName);
  const sortedMessages = [...messages].sort(byName);
  const sortedEvents = [...events].sort(byName);
  return {
    components: Object.freeze(sortedComponents),
    messages: Object.freeze(sortedMessages),
    events: Object.freeze(sortedEvents),
  };
}

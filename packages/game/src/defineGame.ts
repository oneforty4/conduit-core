import { createCompatibilityDescriptor, type MessageDef } from '@conduit/protocol';
import type { ComponentType, EventType, InputFrame } from '@conduit/sim';
import type { WorldGraph, WorldGraphJson } from '@conduit/world';
import { assignIds, buildGameRegistry } from './registry.ts';
import type { Game, GameDefInput } from './types.ts';
import { validateGameDef } from './validate.ts';

function indexByName<T extends { readonly name: string }>(items: readonly T[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) map.set(item.name, item);
  return map;
}

/**
 * Validates a game definition, merges the core components and events, builds the schema registry
 * and resolves component and event IDs within that registry, so server and client agree regardless of
 * import order (docs/game.md 1). Throws `GameDefError`; `SchemaRegistry` limits the core does not
 * pre-check (more than 128 messages or 256 events) throw its `RangeError`.
 * Definitions are immutable and may be shared by differently ordered games.
 */
export function defineGame<I extends InputFrame>(def: GameDefInput<I>): Game<I> {
  const checked = validateGameDef(def);
  const registry = buildGameRegistry({
    components: checked.components,
    messages: checked.messages,
    events: checked.events,
    input: def.input,
  });
  const { components, messages, events } = assignIds(
    checked.components,
    checked.messages,
    checked.events,
  );
  const worldFn = def.world;
  const seed = def.seed;
  const graphs = new Map<number, WorldGraphJson>();
  const componentsByName = indexByName<ComponentType<unknown>>(components);
  const messagesByName = indexByName<MessageDef<unknown>>(messages);
  const eventsByName = indexByName<EventType<unknown>>(events);

  const game: Game<I> = {
    id: def.id,
    name: def.name,
    protocolVersion: def.protocolVersion,
    compatibility: createCompatibilityDescriptor(def.id, def.compatibility),
    tickRate: checked.tickRate,
    snapshotEvery: checked.snapshotEvery,
    seed,
    components,
    messages,
    events,
    input: def.input,
    systems: Object.freeze([...def.systems]),
    registry,
    registryHash: registry.hash,
    ...(def.assets === undefined ? {} : { assets: def.assets }),
    world(worldSeed: number): WorldGraph {
      return worldFn(worldSeed);
    },
    graphJson(worldSeed: number = seed): WorldGraphJson {
      let json = graphs.get(worldSeed);
      if (json === undefined) {
        json = worldFn(worldSeed).toJson();
        graphs.set(worldSeed, json);
      }
      return json;
    },
    component: (name) => componentsByName.get(name),
    message: (name) => messagesByName.get(name),
    event: (name) => eventsByName.get(name),
  };
  return Object.freeze(game);
}

import { GridWorld } from './gridWorld.ts';
import { NodeWorld } from './nodeWorld.ts';
import { WorldGraphError, type RegionId, type WorldGraph, type WorldGraphJson } from './types.ts';

/**
 * Checks what every graph JSON must satisfy (docs/world.md §1): `version === 1`, a known `kind`,
 * unique region ids, and every neighbour naming a region. Throws `WorldGraphError`. Kind-specific
 * checks belong to `GridWorld.fromJson` and `NodeWorld.fromJson`.
 */
export function validateGraphJson(json: WorldGraphJson): void {
  if (json.version !== 1) {
    throw new WorldGraphError(`unsupported world graph version ${String(json.version)}`);
  }
  if (json.kind !== 'grid' && json.kind !== 'node') {
    throw new WorldGraphError(`unknown world graph kind '${String(json.kind)}'`);
  }
  if (!Array.isArray(json.regions)) throw new WorldGraphError('regions must be an array');
  const ids = new Set<RegionId>(); // lookup only
  for (const def of json.regions) {
    if (ids.has(def.id)) throw new WorldGraphError(`duplicate region id '${def.id}'`);
    ids.add(def.id);
  }
  for (const def of json.regions) {
    for (const n of def.neighbors) {
      if (!ids.has(n)) {
        throw new WorldGraphError(`region '${def.id}' lists unknown neighbour '${n}'`);
      }
    }
  }
}

/**
 * Rebuilds a graph from its JSON form: validates, then dispatches on `kind` to `GridWorld.fromJson`
 * or `NodeWorld.fromJson`. Throws `WorldGraphError`.
 */
export function fromJson(json: WorldGraphJson): WorldGraph {
  validateGraphJson(json);
  return json.kind === 'grid' ? GridWorld.fromJson(json) : NodeWorld.fromJson(json);
}

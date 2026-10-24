import type { Vec3 } from '@conduit/math';
import { stringCompare } from './sorted.ts';
import {
  WorldGraphError,
  type RegionDef,
  type RegionId,
  type WorldGraph,
  type WorldGraphJson,
} from './types.ts';

export interface NodeWorldOpts {
  /**
   * Replaces the breadth-first `wanted`. Called only for known ids, with the requested `depth`
   * (`wantedDepth` when the caller passes none); the result is deduplicated and `id` is forced
   * first.
   */
  wanted?: (id: RegionId, graph: NodeWorld, depth: number) => RegionId[];
}

/**
 * A graph of `node` regions without extent (docs/world.md §3): star systems linked by jump gates.
 * Entities never leave a node by moving; games call `RegionManager.migrate`. Defs are copied at
 * construction, with neighbour lists sorted ascending; callers must not mutate what `get` returns.
 */
export class NodeWorld implements WorldGraph {
  /** Default `depth` of `wanted`: direct neighbours. */
  readonly wantedDepth: number = 1;
  /** Lookup only; never iterated. */
  private readonly defs = new Map<RegionId, RegionDef>();
  /** The defs ascending by id, for `toJson`. */
  private readonly sorted: RegionDef[];
  private readonly override: NodeWorldOpts['wanted'];

  /**
   * Throws `WorldGraphError` for a duplicate id, a def whose bounds are not `node`, a neighbour that
   * is not a region of the graph, the region itself, or listed twice.
   */
  constructor(defs: readonly RegionDef[], opts: NodeWorldOpts = {}) {
    const copies: RegionDef[] = [];
    for (const def of defs) {
      if (this.defs.has(def.id)) throw new WorldGraphError(`duplicate region id '${def.id}'`);
      if (def.bounds.kind !== 'node') {
        throw new WorldGraphError(
          `NodeWorld region '${def.id}' has '${String(def.bounds.kind)}' bounds; only 'node' is allowed`,
        );
      }
      const o = def.bounds.origin;
      const copy: RegionDef = {
        id: def.id,
        kind: def.kind,
        bounds: { kind: 'node', origin: { x: o.x, y: o.y, z: o.z } },
        neighbors: def.neighbors.slice().sort(stringCompare),
        assets: def.assets.slice(),
        seed: def.seed,
      };
      if (def.data !== undefined) copy.data = def.data;
      this.defs.set(def.id, copy);
      copies.push(copy);
    }
    for (const def of copies) {
      const ns = def.neighbors;
      for (let i = 0; i < ns.length; i++) {
        const n = ns[i] as RegionId;
        if (!this.defs.has(n)) {
          throw new WorldGraphError(`region '${def.id}' lists unknown neighbour '${n}'`);
        }
        if (n === def.id) {
          throw new WorldGraphError(`region '${def.id}' lists itself as a neighbour`);
        }
        if (i > 0 && ns[i - 1] === n) {
          throw new WorldGraphError(`region '${def.id}' lists neighbour '${n}' twice`);
        }
      }
    }
    this.sorted = copies.sort((a, b) => stringCompare(a.id, b.id));
    this.override = opts.wanted;
  }

  /**
   * Rebuilds a graph from `toJson` output. Throws `WorldGraphError` unless `version === 1` and
   * `kind === 'node'`, and for everything the constructor rejects. A `wanted` override is code, so it
   * is not part of the JSON.
   */
  static fromJson(json: WorldGraphJson): NodeWorld {
    if (json.version !== 1) {
      throw new WorldGraphError(`unsupported world graph version ${String(json.version)}`);
    }
    if (json.kind !== 'node') {
      throw new WorldGraphError(`NodeWorld.fromJson needs kind 'node', got '${String(json.kind)}'`);
    }
    if (!Array.isArray(json.regions)) throw new WorldGraphError('regions must be an array');
    return new NodeWorld(json.regions);
  }

  get(id: RegionId): RegionDef | undefined {
    return this.defs.get(id);
  }

  /** Neighbour ids ascending; `[]` for an unknown id. */
  neighbors(id: RegionId): RegionId[] {
    return this.defs.get(id)?.neighbors.slice() ?? [];
  }

  /** `hint` when it names a region of the graph, else `null`: nodes have no extent to search. */
  locate(_worldPos: Vec3, hint?: RegionId): RegionId | null {
    return hint !== undefined && this.defs.has(hint) ? hint : null;
  }

  /**
   * `id` first, then the regions 1, 2, … `depth` hops away, each hop ascending by id and each region
   * once (or the `wanted` override's result, deduplicated, with `id` first). `[]` for an unknown id.
   * Throws `RangeError` unless `depth` is an integer >= 0.
   */
  wanted(id: RegionId, depth: number = this.wantedDepth): RegionId[] {
    if (!Number.isSafeInteger(depth) || depth < 0) {
      throw new RangeError(`NodeWorld.wanted: depth must be an integer >= 0, got ${depth}`);
    }
    if (!this.defs.has(id)) return [];
    const out: RegionId[] = [id];
    const seen = new Set<RegionId>(out); // lookup only
    if (this.override !== undefined) {
      for (const r of this.override(id, this, depth)) {
        if (!seen.has(r)) {
          seen.add(r);
          out.push(r);
        }
      }
      return out;
    }
    let frontier: RegionId[] = out.slice();
    for (let hop = 1; hop <= depth && frontier.length > 0; hop++) {
      const next: RegionId[] = [];
      for (const from of frontier) {
        for (const n of (this.defs.get(from) as RegionDef).neighbors) {
          if (!seen.has(n)) {
            seen.add(n);
            next.push(n);
          }
        }
      }
      next.sort(stringCompare);
      for (const n of next) out.push(n);
      frontier = next;
    }
    return out;
  }

  /**
   * Every region ascending by id, as fresh copies; `data` is included as its JSON round-trip, and
   * omitted when `JSON.stringify` throws or yields nothing.
   */
  toJson(): WorldGraphJson {
    const regions: RegionDef[] = [];
    for (const def of this.sorted) {
      const o = def.bounds.origin;
      const out: RegionDef = {
        id: def.id,
        kind: def.kind,
        bounds: { kind: 'node', origin: { x: o.x, y: o.y, z: o.z } },
        neighbors: def.neighbors.slice(),
        assets: def.assets.slice(),
        seed: def.seed,
      };
      const data = jsonValue(def.data);
      if (data !== undefined) out.data = data;
      regions.push(out);
    }
    return { version: 1, kind: 'node', regions };
  }
}

/** `value` as it reads back from JSON; `undefined` when `JSON.stringify` throws or yields nothing. */
function jsonValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    return undefined;
  }
  return text === undefined ? undefined : (JSON.parse(text) as unknown);
}

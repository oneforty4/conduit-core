import { Rng } from '@conduit/math';
import type { EntityId } from '@conduit/protocol';
import { describe, expect, it } from 'vitest';
import {
  GridWorld,
  InterestPolicy,
  insertSorted,
  intersectSorted,
  removeSorted,
  stringCompare,
  type InterestClient,
  type RegionId,
  type RegionMembership,
} from '../src/index.ts';

/** Stand-in for `RegionManager`: every placed entity is in an active region. */
class FakeMembership implements RegionMembership {
  private readonly regionByEntity = new Map<EntityId, RegionId>();

  place(e: EntityId, region: RegionId): this {
    this.regionByEntity.set(e, region);
    return this;
  }

  regionOf(e: EntityId): RegionId | undefined {
    return this.regionByEntity.get(e);
  }

  entitiesIn(id: RegionId): readonly EntityId[] {
    const out: EntityId[] = [];
    for (const [e, region] of this.regionByEntity) if (region === id) out.push(e);
    return out.sort((a, b) => a - b);
  }
}

const sorted = (ids: readonly RegionId[]): RegionId[] => [...ids].sort(stringCompare);

const grid = new GridWorld({ cellSize: 100, cols: 8, rows: 8, worldSeed: 9 });

function policy(membership: RegionMembership): InterestPolicy {
  return new InterestPolicy({ graph: grid, regions: membership });
}

/** Chebyshev distance between two cells of `g`. */
function ring(g: GridWorld, a: RegionId, b: RegionId): number {
  const p = g.indexOf(a);
  const q = g.indexOf(b);
  if (p === undefined || q === undefined) throw new Error(`not a cell: ${a} or ${b}`);
  return Math.max(Math.abs(p.ix - q.ix), Math.abs(p.iy - q.iy));
}

/**
 * Player 99 in cell/3_3. Entities: cell/3_3 {40, 7, 99}, cell/4_3 {3, 25}, cell/2_2 {12} (wanted,
 * never reported below), cell/7_7 {1} (distant).
 */
function world(): FakeMembership {
  return new FakeMembership()
    .place(99, 'cell/3_3')
    .place(40, 'cell/3_3')
    .place(7, 'cell/3_3')
    .place(25, 'cell/4_3')
    .place(3, 'cell/4_3')
    .place(12, 'cell/2_2')
    .place(1, 'cell/7_7');
}

describe('InterestPolicy regions', () => {
  it('wantedForRegion is graph.wanted', () => {
    const interest = policy(world());
    for (const r of ['cell/3_3', 'cell/0_0', 'cell/7_4']) {
      expect(interest.wantedForRegion(r)).toEqual(grid.wanted(r));
    }
  });

  it('prefetchForRegion is the depth + 1 ring only', () => {
    const interest = policy(world());
    const r = 'cell/3_3';
    const prefetch = interest.prefetchForRegion(r);
    expect(prefetch).toHaveLength(16);
    for (const id of prefetch) expect(ring(grid, r, id), id).toBe(2);
    expect(prefetch).toEqual(grid.wanted(r, 2).filter((id) => ring(grid, r, id) === 2));
    expect(sorted([...prefetch, ...interest.wantedForRegion(r)])).toEqual(
      sorted(grid.wanted(r, 2)),
    );

    expect(interest.prefetchForRegion('cell/0_0')).toEqual([
      'cell/2_0',
      'cell/2_1',
      'cell/0_2',
      'cell/1_2',
      'cell/2_2',
    ]);
    expect(interest.prefetchForRegion('cell/99_99')).toEqual([]);
  });

  it('the prefetch ring follows the graph wantedDepth', () => {
    const deep = new GridWorld({ cellSize: 100, cols: 12, rows: 12, worldSeed: 9, wantedDepth: 2 });
    const interest = new InterestPolicy({ graph: deep, regions: world() });
    expect(interest.wantedForRegion('cell/5_5')).toHaveLength(25);
    const prefetch = interest.prefetchForRegion('cell/5_5');
    expect(prefetch).toHaveLength(49 - 25);
    for (const id of prefetch) expect(ring(deep, 'cell/5_5', id)).toBe(3);
  });

  it('wantedFor and prefetchFor use the player region, and are empty while unplaced', () => {
    const interest = policy(world());
    expect(interest.wantedFor(99)).toEqual(interest.wantedForRegion('cell/3_3'));
    expect(interest.prefetchFor(99)).toEqual(interest.prefetchForRegion('cell/3_3'));
    expect(interest.prefetchFor(99)).toHaveLength(16);
    expect(interest.wantedFor(1234)).toEqual([]);
    expect(interest.prefetchFor(1234)).toEqual([]);
  });
});

describe('InterestPolicy.visible', () => {
  const client = (reported: RegionId[]): InterestClient => ({
    player: 99,
    wanted: sorted(grid.wanted('cell/3_3')),
    reported: sorted(reported),
  });

  it('is wanted ∩ reported, in ascending entity order', () => {
    const interest = policy(world());
    // cell/7_7 is reported but not wanted; cell/2_2 is wanted but not reported.
    const out = interest.visible(client(['cell/4_3', 'cell/7_7', 'cell/3_3', 'cell/0_0']), []);
    expect(out).toEqual([3, 7, 25, 40, 99]);
  });

  it('does not filter entities: per-entity relevance is the Session hook, applied per snapshot', () => {
    const interest = policy(world());
    // Every entity of every wanted and reported region, the client's own player included.
    const out = interest.visible(client(['cell/3_3', 'cell/4_3', 'cell/2_2']), []);
    expect(out).toEqual([3, 7, 12, 25, 40, 99]);
    const withRelevance = new InterestPolicy({
      graph: grid,
      regions: world(),
      // @ts-expect-error relevance is not an InterestPolicy option (docs/world.md §9)
      relevance: () => false,
    });
    expect(withRelevance.visible(client(['cell/3_3']), [])).toEqual([7, 40, 99]);
  });

  it('clears and returns out', () => {
    const interest = policy(world());
    const out = [1000, 2000, 3000, 4000, 5000, 6000, 7000];
    expect(interest.visible(client(['cell/4_3']), out)).toBe(out);
    expect(out).toEqual([3, 25]);
  });

  it('a client whose reported set does not include its wanted region sees nothing', () => {
    const interest = policy(world());
    expect(interest.visible(client(['cell/7_7']), [42])).toEqual([]);
    expect(interest.visible(client([]), [])).toEqual([]);
    const unplaced: InterestClient = {
      player: 1234,
      wanted: interest.wantedFor(1234),
      reported: ['cell/3_3'],
    };
    expect(interest.visible(unplaced, [])).toEqual([]);
  });
});

describe('sorted helpers', () => {
  it('stringCompare orders by code unit, not locale', () => {
    const ids = ['b', 'é', 'cell/9_0', 'B', 'e', 'cell/10_0', 'a'];
    expect(ids.sort(stringCompare)).toEqual(['B', 'a', 'b', 'cell/10_0', 'cell/9_0', 'e', 'é']);
    expect(stringCompare('cell/1_1', 'cell/1_1')).toBe(0);
  });

  it('insertSorted and removeSorted keep an array ascending and duplicate-free', () => {
    const rng = new Rng(3);
    const numbers: number[] = [];
    const strings: string[] = [];
    const reference = new Set<number>();
    for (let i = 0; i < 4000; i++) {
      const n = rng.int(0, 150);
      const s = `cell/${n}_0`;
      if (rng.chance(0.6)) {
        expect(insertSorted(numbers, n)).toBe(!reference.has(n));
        expect(insertSorted(strings, s)).toBe(!reference.has(n));
        reference.add(n);
      } else {
        expect(removeSorted(numbers, n)).toBe(reference.has(n));
        expect(removeSorted(strings, s)).toBe(reference.has(n));
        reference.delete(n);
      }
    }
    expect(numbers).toEqual([...reference].sort((a, b) => a - b));
    expect(strings).toEqual([...reference].map((n) => `cell/${n}_0`).sort(stringCompare));
  });

  it('intersectSorted appends the common elements in ascending order', () => {
    expect(intersectSorted([1, 3, 5, 7], [2, 3, 4, 7, 9])).toEqual([3, 7]);
    expect(intersectSorted(['a', 'c', 'd'], ['b', 'c', 'd', 'e'])).toEqual(['c', 'd']);
    expect(intersectSorted([], [1, 2])).toEqual([]);
    const out = [0];
    expect(intersectSorted([1, 2], [2, 3], out)).toBe(out);
    expect(out).toEqual([0, 2]);
  });
});

import type { RegionId } from '@conduit/world';

/** The `RenderWorld` members `RegionGroups` uses. */
export interface RegionGroupWorld {
  regionGroup(id: RegionId): unknown;
  hasRegionGroup(id: RegionId): boolean;
  releaseRegionGroup(id: RegionId): void;
}

/**
 * Keeps a render-world region group for every region the client holds (`FrameContext.regions.loaded`
 * and `loading`), so `RegionBoundsHelper` (the `B` key) outlines exactly the streamed regions, and
 * releases the group of a region once it is no longer held. Views create groups on demand but
 * nothing else removes them, so without this they would pile up behind a moving player.
 * `releaseRegionGroup` keeps a group while a view is still in it, so the release is retried on every
 * `sync` until the group is gone or the region is held again. Groups this class never created (such
 * as the e2e test's `cell/0_0`) are left alone.
 */
export class RegionGroups {
  private readonly held = new Set<RegionId>();
  private readonly releasing = new Set<RegionId>();
  private lastLoaded: readonly RegionId[] | null = null;
  private lastLoading: readonly RegionId[] | null = null;

  /** Call once per frame. `loaded` and `loading` are only re-read when their arrays change. */
  sync(world: RegionGroupWorld, loaded: readonly RegionId[], loading: readonly RegionId[]): void {
    if (loaded !== this.lastLoaded || loading !== this.lastLoading) {
      this.lastLoaded = loaded;
      this.lastLoading = loading;
      const now = new Set([...loaded, ...loading]);
      for (const id of now) {
        this.releasing.delete(id);
        this.held.add(id);
        world.regionGroup(id); // created on demand; the same group when it exists
      }
      for (const id of this.held) {
        if (now.has(id)) continue;
        this.held.delete(id);
        this.releasing.add(id);
      }
    }
    for (const id of this.releasing) {
      world.releaseRegionGroup(id);
      if (!world.hasRegionGroup(id)) this.releasing.delete(id);
    }
  }

  /** Regions whose group waits for its last view to leave. */
  get pendingReleases(): number {
    return this.releasing.size;
  }
}

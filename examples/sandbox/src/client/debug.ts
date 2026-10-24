import type { AssetLoader, Manifest } from '@conduit/assets';
import type { ClientState, ConnectResult, FrameContext, GameClient } from '@conduit/game/client';
import type { RenderHost, RenderWorld } from '@conduit/render';
import type { RegionId } from '@conduit/world';
import type { SandboxInput } from '../shared/input.ts';

/** `window.__conduit`, the Playwright surface (PLAN.md "Sandbox content spec"). */
export interface ConduitDebug {
  /** Resolves after the own `Spawned` and the first frame that follows; rejects if connecting fails. */
  readonly ready: Promise<void>;
  readonly client: GameClient<SandboxInput>;
  /** Set by the first rendered frame. */
  readonly host: RenderHost | undefined;
  /**
   * Set by the first rendered frame. Region groups are reachable through it: `regionGroup(id)`,
   * `hasRegionGroup(id)` and `releaseRegionGroup(id)` (a no-op while a view is in the group).
   */
  readonly world: RenderWorld | undefined;
  /** `client.assets`: built by `connect()`; `undefined` before that or without a manifest. */
  readonly assets: AssetLoader | undefined;
  /** The loader's manifest (as fetched from `/assets/manifest.json`); `undefined` without one. */
  readonly manifest: Manifest | undefined;
  state(): ClientState;
  /** `replica.visibleAt(clock.renderTick())` count. */
  replicaCount(): number;
  /**
   * Where the local vehicle is drawn, in world space: its view's position plus the origin of the
   * region group the view is in. `RegionBinder` moves a view to its entity's new region only when the
   * render tick reaches the crossing, so this never pairs the newest `Region` with an older
   * `Transform` sample (which jumps by a cell). `null` until the view exists.
   */
  localPosition(): { x: number; y: number; z: number } | null;
  /** `client.regions.loaded()`: every region held, including those in their release grace. */
  regionsLoaded(): RegionId[];
  readonly debug: {
    /**
     * Runs every pending loader grace timer now (docs/render.md 10.3), so released assets are
     * disposed at once instead of after `unloadGraceMs`; resolves after a macrotask.
     */
    expireGrace(): Promise<void>;
  };
}

declare global {
  interface Window {
    __conduit?: ConduitDebug;
  }
}

/** The most timers one `expireAll` runs, so a callback that keeps re-arming cannot hang it. */
const MAX_EXPIRED_PER_CALL = 10_000;

/**
 * The `AssetLoader`'s grace timers (`AssetLoaderOptions.setTimer`/`clearTimer`): real `setTimeout`s
 * that `expireAll` can run early. Pass `set` and `clear` to `createClient`'s `assetLoader` option.
 */
export class GraceTimers {
  private readonly pending = new Map<
    number,
    { fn: () => void; handle: ReturnType<typeof setTimeout> }
  >();
  private nextId = 1;

  readonly set = (fn: () => void, ms: number): unknown => {
    const id = this.nextId++;
    const handle = setTimeout(() => {
      this.pending.delete(id);
      fn();
    }, ms);
    this.pending.set(id, { fn, handle });
    return id;
  };

  readonly clear = (id: unknown): void => {
    const entry = typeof id === 'number' ? this.pending.get(id) : undefined;
    if (entry === undefined) return;
    clearTimeout(entry.handle);
    this.pending.delete(id as number);
  };

  /** Timers not yet run. */
  get size(): number {
    return this.pending.size;
  }

  /**
   * Runs every pending timer now, oldest first, including timers those callbacks set (a released
   * dependency starts its own grace). Returns how many ran.
   */
  expireAll(): number {
    let ran = 0;
    for (const [id, entry] of this.pending) {
      if (ran >= MAX_EXPIRED_PER_CALL) break;
      clearTimeout(entry.handle);
      this.pending.delete(id);
      ran += 1;
      entry.fn(); // may set timers: a Map iterates entries added during the loop
    }
    return ran;
  }
}

/**
 * Whether `connect()` built the client's NetClient yet (with a canvas, once the render module has
 * loaded); until then `replica`, `clock`, `net` and `regions` throw.
 */
function hasNet(client: GameClient<SandboxInput>): boolean {
  try {
    return client.net !== undefined;
  } catch {
    return false;
  }
}

/**
 * Installs `window.__conduit` for `client`, whose `connect()` promise is `connecting` and whose
 * loader was built with `timers`. Returns the frame hook that `onFrame` must call.
 */
export function installDebug(
  client: GameClient<SandboxInput>,
  connecting: Promise<ConnectResult>,
  timers: GraceTimers,
): (frame: FrameContext<SandboxInput>) => void {
  let host: RenderHost | undefined;
  let world: RenderWorld | undefined;
  let spawned = false;
  let frameAfterSpawn!: () => void;
  const firstFrame = new Promise<void>((resolve) => {
    frameAfterSpawn = resolve;
  });
  const ready = connecting.then(() => {
    spawned = true;
    return firstFrame;
  });
  ready.catch(() => {}); // awaiters still see the rejection; the page does not log it as unhandled

  const debug: ConduitDebug = {
    ready,
    client,
    get host() {
      return host;
    },
    get world() {
      return world;
    },
    get assets() {
      return client.assets;
    },
    get manifest() {
      return client.assets?.manifest;
    },
    state: () => client.state,
    replicaCount() {
      if (!hasNet(client)) return 0;
      let n = 0;
      for (const _ of client.replica.visibleAt(client.clock.renderTick())) n++;
      return n;
    },
    localPosition() {
      const e = client.localEntity;
      const view = e === undefined ? undefined : world?.view(e);
      const origin = view && world?.graph.get(view.regionId)?.bounds.origin;
      if (view === undefined || origin === undefined) return null;
      // Region-local: the TransformBinder's sample plus RegionBinder's frame offset.
      const p = view.object.position;
      return { x: origin.x + p.x, y: origin.y + p.y, z: origin.z + p.z };
    },
    regionsLoaded: () => (hasNet(client) ? client.regions.loaded() : []),
    debug: {
      async expireGrace() {
        timers.expireAll();
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      },
    },
  };
  window.__conduit = debug;

  return (frame) => {
    if (frame.render !== undefined) {
      host = frame.render.host;
      world = frame.render.world;
    }
    if (spawned && frame.localEntity !== undefined) frameAfterSpawn();
  };
}

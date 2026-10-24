import type { RenderHost } from '../host.ts';
import type { RenderWorld } from '../world.ts';

/** One `statsHook` report (docs/render.md §8). */
export interface RenderStats {
  /** Frames per second over the report window, from raw elapsed frame time. */
  fps: number;
  /** Raw elapsed frame seconds before animation clamping. */
  rawDt: number;
  /** Seconds; the `dt` of the last frame in the window (clamped to `MAX_DT` by the host). */
  dt: number;
  /** `renderer.info.render` of the last rendered frame. */
  calls: number;
  triangles: number;
  /** `renderer.info.memory`. */
  geometries: number;
  textures: number;
  /** Entity views in the world. */
  views: number;
  /** Region groups under `world.root`. */
  regionGroups: number;
  /** `world.assets.stats().inFlight`, 0 without a loader. */
  loaderInFlight: number;
}

/**
 * Reports render statistics about every `everyMs` milliseconds of frame time: registers a
 * `host.onFrame` callback that counts frames and sums their `dt`, and once the sum reaches
 * `everyMs` calls `cb` with a fresh `RenderStats` and starts a new window. Returns the (idempotent)
 * unsubscribe. Renderer counters are read before the current frame renders, so they describe the
 * previous frame.
 */
export function statsHook(
  host: RenderHost,
  world: RenderWorld,
  cb: (s: RenderStats) => void,
  everyMs = 250,
): () => void {
  let frames = 0;
  let elapsed = 0;
  return host.onFrame((dt) => {
    frames += 1;
    const rawDt = host.rawFrameMs / 1000;
    elapsed += rawDt;
    if (elapsed * 1000 < everyMs) return;
    const info = host.renderer.info;
    let views = 0;
    for (const _view of world.views()) views += 1;
    let regionGroups = 0;
    for (const child of world.root.children) {
      if (typeof child.userData['regionId'] === 'string') regionGroups += 1;
    }
    const stats: RenderStats = {
      fps: elapsed > 0 ? frames / elapsed : 0,
      dt,
      rawDt,
      calls: info.render.calls,
      triangles: info.render.triangles,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      views,
      regionGroups,
      loaderInFlight: world.assets?.stats().inFlight ?? 0,
    };
    frames = 0;
    elapsed = 0;
    cb(stats);
  });
}

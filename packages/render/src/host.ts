import { diagnosticNow, observeDiagnostic, type DiagnosticOptions } from '@conduit/math';
import { PerspectiveCamera, Scene, WebGLRenderer, type Camera, type Object3D } from 'three';
import type { RenderWorld } from './world.ts';

/** The subset of `WebGLRenderer` that `RenderHost` uses; `WebGLRenderer` satisfies it. */
export interface RendererLike {
  render(scene: Object3D, camera: Camera): void;
  setSize(w: number, h: number, updateStyle?: boolean): void;
  setPixelRatio(r: number): void;
  dispose(): void;
  info: {
    memory: { geometries: number; textures: number };
    render: { calls: number; triangles: number };
  };
  domElement: HTMLCanvasElement;
}

export interface RenderHostOptions {
  diagnostics?: DiagnosticOptions | undefined;
  /** Optional asynchronous renderer GPU timer result; omit when unsupported. */
  gpuTiming?: (() => { durationMs?: number; disjoint?: boolean }) | undefined;
  canvas: HTMLCanvasElement;
  /** Game-supplied `WebGLRenderer` or composer-backed adapter; never disposed by the host. */
  renderer?: RendererLike;
  /** Default true; ignored when `renderer` is supplied. */
  antialias?: boolean;
  /** Default `PIXEL_RATIO_CAP_DEFAULT`. */
  pixelRatioCap?: number;
  /** Default `requestAnimationFrame`; injectable for tests. */
  raf?: (cb: FrameRequestCallback) => number;
  /** Default `cancelAnimationFrame`. */
  caf?: (id: number) => void;
  /** Milliseconds; default `performance.now`. */
  now?: () => number;
  /**
   * Called with what a frame threw, once the loop has stopped (it propagates still): where the
   * game decides whether to `start()` again.
   */
  onFrameError?: (error: unknown, host: RenderHost) => void;
}

export const PIXEL_RATIO_CAP_DEFAULT = 2;
/** Seconds; a frame's `dt` is clamped to this (tab throttling, breakpoints). */
export const MAX_DT = 0.1;
export const CAMERA_FOV = 60;
export const CAMERA_NEAR = 0.1;
export const CAMERA_FAR = 20000;

export type RenderFn = (host: RenderHost) => void;
export type FrameCb = (dt: number, host: RenderHost) => void;

interface FrameEntry {
  readonly cb: FrameCb;
  active: boolean;
}

function defaultRender(host: RenderHost): void {
  host.renderer.render(host.scene, host.camera);
}

function devicePixelRatioOr1(): number {
  return typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1;
}

/**
 * Owns the renderer, scene, camera and the animation-frame loop (docs/render.md §2). Each frame:
 * `world.update(dt)` (when `setWorld` was used), then the `onFrame` callbacks in registration
 * order, then the render function. An exception thrown by any of them propagates out of the frame
 * and stops the loop (`running` becomes false); the game, told by `onFrameError`, decides whether
 * to `start()` again.
 */
export class RenderHost {
  readonly renderer: RendererLike;
  readonly scene: Scene;
  /** fov 60, aspect from the canvas, near 0.1, far 20000; the game may mutate it. */
  readonly camera: PerspectiveCamera;
  readonly canvas: HTMLCanvasElement;
  /** Frames rendered so far. */
  frame = 0;

  /**
   * Time base of the current frame: the `requestAnimationFrame` timestamp, shared by everything
   * that runs in the frame, on the `performance.now()` clock. Anything a game does per frame that
   * needs a wall clock -- above all `GameClient`'s `NetClient.update(nowMs)` -- must read this
   * rather than call `performance.now()` itself, so the whole frame is timed from one instant.
   * Seeded by `start()`; 0 before that.
   */
  get timeMs(): number {
    return this.lastMs;
  }

  private readonly ownsRenderer: boolean;
  private readonly raf: (cb: FrameRequestCallback) => number;
  private readonly caf: (id: number) => void;
  private readonly now: () => number;
  private readonly onFrameError: ((error: unknown, host: RenderHost) => void) | undefined;
  private readonly observer: ResizeObserver | null;
  private renderFn: RenderFn | null = null;
  private world: RenderWorld | null = null;
  /** Copy-on-write, so a callback may subscribe or unsubscribe during a frame. */
  private frameCbs: readonly FrameEntry[] = [];
  private isRunning = false;
  private disposed = false;
  private rafId: number | null = null;
  private lastMs = 0;
  private elapsedMs = 0;
  private diagnosticCleanup: (() => void) | undefined;
  get rawFrameMs(): number {
    return this.elapsedMs;
  }
  private readonly diagnostics: DiagnosticOptions | undefined;
  private readonly gpuTiming: RenderHostOptions['gpuTiming'];
  private cssWidth = 1;
  private cssHeight = 1;

  constructor(opts: RenderHostOptions) {
    this.diagnostics = opts.diagnostics;
    this.gpuTiming = opts.gpuTiming;
    const canvas = opts.canvas;
    this.canvas = canvas;
    if (opts.diagnostics !== undefined) {
      const report = (name: string, status: 'error' | 'reset') => {
        const time = diagnosticNow(opts.diagnostics!.now ?? this.now);
        if (time !== undefined)
          observeDiagnostic(opts.diagnostics!.observer, {
            version: 1,
            category: 'gpu',
            name,
            timeMs: time,
            status,
          });
      };
      const lost = () => report('context-lost', 'error');
      const restored = () => report('context-restored', 'reset');
      canvas.addEventListener('webglcontextlost', lost);
      canvas.addEventListener('webglcontextrestored', restored);
      this.diagnosticCleanup = () => {
        canvas.removeEventListener('webglcontextlost', lost);
        canvas.removeEventListener('webglcontextrestored', restored);
      };
    }
    this.raf = opts.raf ?? ((cb) => requestAnimationFrame(cb));
    this.caf = opts.caf ?? ((id) => cancelAnimationFrame(id));
    this.now = opts.now ?? (() => performance.now());
    this.onFrameError = opts.onFrameError;
    this.ownsRenderer = opts.renderer === undefined;
    this.renderer =
      opts.renderer ??
      new WebGLRenderer({
        canvas,
        antialias: opts.antialias ?? true,
        powerPreference: 'high-performance',
      });
    this.renderer.setPixelRatio(
      Math.min(devicePixelRatioOr1(), opts.pixelRatioCap ?? PIXEL_RATIO_CAP_DEFAULT),
    );
    this.scene = new Scene();
    const width = canvas.clientWidth || 1;
    const height = canvas.clientHeight || 1;
    this.camera = new PerspectiveCamera(CAMERA_FOV, width / height, CAMERA_NEAR, CAMERA_FAR);
    // jsdom (and very old browsers) have no ResizeObserver: only manual resize() applies there.
    this.observer =
      typeof ResizeObserver === 'function' ? new ResizeObserver(this.onResizeEntries) : null;
    this.observer?.observe(canvas.parentElement ?? canvas);
    this.resize(width, height);
  }

  get running(): boolean {
    return this.isRunning;
  }

  /**
   * The view's size in CSS pixels as last laid out: what the `ResizeObserver` (or the last
   * `resize()`) gave, at least 1. Per frame, read these rather than `canvas.clientWidth` and
   * `clientHeight`, which lay the page out there and then (a synchronous layout) whenever anything
   * on it changed since the last layout -- as a HUD updated earlier in the frame has.
   */
  get width(): number {
    return this.cssWidth;
  }

  get height(): number {
    return this.cssHeight;
  }

  /** `null` restores the default `renderer.render(scene, camera)`. */
  setRenderFn(fn: RenderFn | null): void {
    this.renderFn = fn;
  }

  /**
   * Optional convenience: `world.update(dt)` runs first each frame. `createClient` does not use it;
   * it calls `NetClient.update` then `world.update` from an `onFrame` callback (docs/game.md §4).
   */
  setWorld(world: RenderWorld | null): void {
    this.world = world;
  }

  /** Called every frame in registration order; returns an idempotent unsubscribe. */
  onFrame(cb: FrameCb): () => void {
    const entry: FrameEntry = { cb, active: true };
    this.frameCbs = [...this.frameCbs, entry];
    return () => {
      if (!entry.active) return;
      entry.active = false;
      this.frameCbs = this.frameCbs.filter((e) => e !== entry);
    };
  }

  start(): void {
    if (this.isRunning || this.disposed) return;
    this.isRunning = true;
    this.lastMs = this.now();
    this.rafId = this.raf(this.tick);
  }

  /** Stops the loop and cancels the pending frame. */
  stop(): void {
    this.isRunning = false;
    if (this.rafId !== null) {
      const id = this.rafId;
      this.rafId = null;
      this.caf(id);
    }
  }

  /** CSS pixels. Also driven by a `ResizeObserver` on the canvas parent. Non-positive sizes count as 1. */
  resize(width: number, height: number): void {
    const w = width > 0 ? width : 1;
    const h = height > 0 ? height : 1;
    this.cssWidth = w;
    this.cssHeight = h;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Stops, disconnects the observer and disposes the renderer only if the host created it. */
  dispose(): void {
    if (this.disposed) return;
    this.stop();
    this.disposed = true;
    this.observer?.disconnect();
    this.diagnosticCleanup?.();
    this.diagnosticCleanup = undefined;
    for (const entry of this.frameCbs) entry.active = false;
    this.frameCbs = [];
    this.world = null;
    this.renderFn = null;
    if (this.ownsRenderer) this.renderer.dispose();
  }

  private readonly onResizeEntries = (entries: ResizeObserverEntry[]): void => {
    const entry = entries[entries.length - 1];
    if (entry !== undefined) this.resize(entry.contentRect.width, entry.contentRect.height);
  };

  private readonly tick = (frameMs?: number): void => {
    this.rafId = null;
    if (!this.isRunning) return;
    // The frame's own timestamp, which the driver passes (every browser rAF does) and which tracks
    // the display's cadence. `now()` here would instead read when this line ran, and the work
    // before it varies from frame to frame, so `dt` and anything driven off it -- the net clock,
    // the camera spring -- would advance unevenly and the world would visibly stutter.
    const t = typeof frameMs === 'number' && Number.isFinite(frameMs) ? frameMs : this.now();
    this.elapsedMs = Math.max(0, t - this.lastMs);
    const dt = Math.min(this.elapsedMs / 1000, MAX_DT);
    this.lastMs = t;
    const diagnostics = this.diagnostics;
    const started =
      diagnostics === undefined ? undefined : diagnosticNow(diagnostics.now ?? this.now);
    try {
      this.world?.update(dt);
      for (const entry of this.frameCbs) {
        if (entry.active) entry.cb(dt, this);
      }
      if (this.disposed) return;
      (this.renderFn ?? defaultRender)(this);
    } catch (err) {
      if (diagnostics !== undefined)
        observeDiagnostic(diagnostics.observer, {
          version: 1,
          category: 'error',
          name: 'render-frame',
          timeMs: t,
          status: 'error',
        });
      this.stop();
      this.onFrameError?.(err, this);
      throw err;
    }
    if (diagnostics !== undefined) {
      observeDiagnostic(diagnostics.observer, {
        version: 1,
        category: 'frame',
        name: 'elapsed',
        timeMs: t,
        durationMs: this.elapsedMs,
        unit: 'ms',
      });
      const ended = diagnosticNow(diagnostics.now ?? this.now);
      if (ended !== undefined)
        observeDiagnostic(diagnostics.observer, {
          version: 1,
          category: 'pipeline',
          name: 'render',
          timeMs: ended,
          durationMs: started === undefined ? undefined : Math.max(0, ended - started),
          status: started === undefined || ended < started ? 'unavailable' : 'ok',
        });
      let gpu: { durationMs?: number; disjoint?: boolean } | undefined;
      try {
        gpu = this.gpuTiming?.();
      } catch {
        /* Unavailable diagnostic adapter. */
      }
      const duration = gpu?.durationMs;
      observeDiagnostic(diagnostics.observer, {
        version: 1,
        category: 'gpu',
        name: 'frame',
        timeMs: t,
        durationMs:
          gpu?.disjoint !== true &&
          duration !== undefined &&
          Number.isFinite(duration) &&
          duration >= 0
            ? duration
            : undefined,
        status:
          gpu?.disjoint === true ||
          duration === undefined ||
          !Number.isFinite(duration) ||
          duration < 0
            ? 'unavailable'
            : 'ok',
      });
    }
    this.frame += 1;
    if (this.isRunning && this.rafId === null) this.rafId = this.raf(this.tick);
  };
}

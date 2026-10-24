import { AssetLoader } from '@conduit/assets';
import type { DiagnosticRecord } from '@conduit/math';
import type * as Three from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Mesh, MeshBasicMaterial, Texture } from 'three';
import {
  CAMERA_FAR,
  CAMERA_FOV,
  CAMERA_NEAR,
  MAX_DT,
  PIXEL_RATIO_CAP_DEFAULT,
  RenderHost,
  type RenderHostOptions,
  statsHook,
  type RenderStats,
} from '../src/index.ts';
import { FakeRenderer, FrameDriver } from './fake-renderer.ts';
import { createWorld, regionOf, ReplicaFixture } from './replica-fixture.ts';

interface CreatedRenderer {
  params: Record<string, unknown>;
  disposeCalls: number;
}

// jsdom has no WebGL: a host-created renderer is this stand-in (every other export is real three).
const mocks = vi.hoisted(() => ({ created: [] as CreatedRenderer[] }));

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof Three>();
  class StubWebGLRenderer {
    readonly params: Record<string, unknown>;
    readonly domElement: HTMLCanvasElement;
    readonly info = { memory: { geometries: 0, textures: 0 }, render: { calls: 0, triangles: 0 } };
    disposeCalls = 0;
    constructor(params: Record<string, unknown>) {
      this.params = params;
      this.domElement = params['canvas'] as HTMLCanvasElement;
      mocks.created.push(this);
    }
    render(): void {}
    setSize(): void {}
    setPixelRatio(): void {}
    dispose(): void {
      this.disposeCalls += 1;
    }
  }
  return { ...actual, WebGLRenderer: StubWebGLRenderer };
});

function sizedCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  Object.defineProperty(canvas, 'clientWidth', { value: width });
  Object.defineProperty(canvas, 'clientHeight', { value: height });
  return canvas;
}

function fakeHost(
  canvas = document.createElement('canvas'),
  opts: Partial<RenderHostOptions> = {},
): {
  host: RenderHost;
  renderer: FakeRenderer;
  frames: FrameDriver;
} {
  const frames = new FrameDriver();
  const renderer = new FakeRenderer(canvas);
  const host = new RenderHost({
    canvas,
    renderer,
    raf: frames.raf,
    caf: frames.caf,
    now: frames.now,
    ...opts,
  });
  return { host, renderer, frames };
}

afterEach(() => {
  vi.unstubAllGlobals();
  mocks.created.length = 0;
});

describe('RenderHost construction', () => {
  it('builds a scene and a perspective camera sized from the canvas', () => {
    const { host, renderer } = fakeHost(sizedCanvas(640, 480));
    expect(host.renderer).toBe(renderer);
    expect(host.canvas).toBe(renderer.domElement);
    expect(host.scene.isScene).toBe(true);
    expect(host.camera.isPerspectiveCamera).toBe(true);
    expect([host.camera.fov, host.camera.near, host.camera.far]).toEqual([
      CAMERA_FOV,
      CAMERA_NEAR,
      CAMERA_FAR,
    ]);
    expect([CAMERA_FOV, CAMERA_NEAR, CAMERA_FAR]).toEqual([60, 0.1, 20000]);
    expect(host.camera.aspect).toBeCloseTo(640 / 480, 12);
    expect(renderer.sizes).toEqual([{ width: 640, height: 480, updateStyle: false }]);
    expect(host.running).toBe(false);
    expect(host.frame).toBe(0);
  });

  it('falls back to 1 x 1 for a canvas without layout (jsdom)', () => {
    const { host, renderer } = fakeHost();
    expect(renderer.sizes).toEqual([{ width: 1, height: 1, updateStyle: false }]);
    expect(host.camera.aspect).toBe(1);
  });

  it(`caps the pixel ratio at pixelRatioCap (default ${PIXEL_RATIO_CAP_DEFAULT})`, () => {
    vi.stubGlobal('devicePixelRatio', 3);
    expect(fakeHost().renderer.pixelRatio).toBe(2);
    const renderer = new FakeRenderer();
    new RenderHost({ canvas: renderer.domElement, renderer, pixelRatioCap: 1.5 });
    expect(renderer.pixelRatio).toBe(1.5);
    vi.stubGlobal('devicePixelRatio', 1.25);
    expect(fakeHost().renderer.pixelRatio).toBe(1.25);
  });
});

describe('RenderHost frame loop', () => {
  it('times the frame from the rAF timestamp and hands it to callbacks as timeMs', () => {
    // The timestamp is the frame's own time and tracks the display's cadence. Reading `now()` in
    // the callback instead measures when the callback ran, after however much work came first, and
    // a net clock driven off that advances unevenly: the world visibly stutters.
    const canvas = document.createElement('canvas');
    const pending: ((t: number) => void)[] = [];
    let now = 1000;
    const host = new RenderHost({
      canvas,
      renderer: new FakeRenderer(canvas),
      raf: (cb) => pending.push(cb),
      caf: () => {},
      now: () => now,
    });
    const seen: { dt: number; timeMs: number }[] = [];
    host.onFrame((dt, h) => seen.push({ dt, timeMs: h.timeMs }));
    /** A frame at `frameMs` whose callback ran `lag` ms into it. */
    const step = (frameMs: number, lag: number): void => {
      now = frameMs + lag;
      (pending.shift() as (t: number) => void)(frameMs);
    };

    host.start();
    step(1000, 3);
    step(1016, 12); // 16 ms of frames, 25 ms of wall clock since the previous callback
    step(1032, 1); // 16 ms of frames, 5 ms of wall clock
    expect(seen).toEqual([
      { dt: 0, timeMs: 1000 },
      { dt: 0.016, timeMs: 1016 },
      { dt: 0.016, timeMs: 1032 },
    ]);
    host.stop();
  });

  it('runs world.update, then onFrame callbacks in registration order, then the render fn', () => {
    const { host, frames, world } = createWorld();
    const order: string[] = [];
    const update = world.update.bind(world);
    vi.spyOn(world, 'update').mockImplementation((dt) => {
      order.push(`world ${dt}`);
      update(dt);
    });
    host.setWorld(world);
    host.onFrame((dt, h) => {
      expect(h).toBe(host);
      order.push(`first ${dt}`);
    });
    host.onFrame((dt) => order.push(`second ${dt}`));
    host.setRenderFn((h) => {
      expect(h).toBe(host);
      order.push('render');
    });

    host.start();
    expect(host.running).toBe(true);
    expect(order).toEqual([]);
    expect(frames.stepFrame(16)).toBe(1);
    expect(order).toEqual(['world 0.016', 'first 0.016', 'second 0.016', 'render']);
    expect(host.frame).toBe(1);

    order.length = 0;
    host.setWorld(null);
    frames.stepFrame(20);
    expect(order).toEqual(['first 0.02', 'second 0.02', 'render']);
    expect(host.frame).toBe(2);
  });

  it('dt is the time since the previous frame in seconds, clamped to MAX_DT and at least 0', () => {
    const { host, frames } = fakeHost();
    const dts: number[] = [];
    host.onFrame((dt) => dts.push(dt));
    host.start();
    frames.stepFrame(10);
    frames.stepFrame(5000); // a throttled background tab
    frames.nowMs -= 50; // a clock that stepped back
    frames.stepFrame(0);
    frames.stepFrame(25);
    expect(dts).toEqual([0.01, MAX_DT, 0, 0.025]);
    expect(MAX_DT).toBe(0.1);
  });

  it('stop cancels the pending frame; start resumes with dt measured from the restart', () => {
    const { host, frames } = fakeHost();
    const dts: number[] = [];
    host.onFrame((dt) => dts.push(dt));
    host.start();
    host.start(); // no second frame request
    expect(frames.pendingCount).toBe(1);
    frames.stepFrame(16);
    host.stop();
    expect(host.running).toBe(false);
    expect(frames.pendingCount).toBe(0);
    expect(frames.stepFrame(16)).toBe(0);
    expect(host.frame).toBe(1);

    frames.nowMs += 60_000;
    host.start();
    frames.stepFrame(30);
    expect(dts).toEqual([0.016, 0.03]);
    expect(host.frame).toBe(2);
  });

  it('stop from inside a frame callback renders that frame and requests no other', () => {
    const { host, frames, renderer } = fakeHost();
    host.onFrame(() => host.stop());
    host.start();
    frames.stepFrame();
    expect(renderer.renders).toHaveLength(1);
    expect(frames.pendingCount).toBe(0);
    expect(host.running).toBe(false);
  });

  it('setRenderFn(null) restores the default renderer.render(scene, camera)', () => {
    const { host, frames, renderer } = fakeHost();
    host.start();
    frames.stepFrame();
    expect(renderer.renders).toEqual([{ scene: host.scene, camera: host.camera }]);

    const custom = vi.fn();
    host.setRenderFn(custom);
    frames.stepFrame();
    expect(custom).toHaveBeenCalledTimes(1);
    expect(renderer.renders).toHaveLength(1);

    host.setRenderFn(null);
    frames.stepFrame();
    expect(custom).toHaveBeenCalledTimes(1);
    expect(renderer.renders).toHaveLength(2);
    expect(renderer.renders[1]).toEqual({ scene: host.scene, camera: host.camera });
  });

  it('onFrame returns an idempotent unsubscribe that also applies within the current frame', () => {
    const { host, frames } = fakeHost();
    const calls: string[] = [];
    let offB = (): void => {};
    host.onFrame(() => {
      calls.push('a');
      offB();
    });
    offB = host.onFrame(() => calls.push('b'));
    const offC = host.onFrame(() => calls.push('c'));
    host.start();
    frames.stepFrame();
    offC();
    offC();
    frames.stepFrame();
    expect(calls).toEqual(['a', 'c', 'a']);
  });

  it('an exception from a frame callback propagates and stops the loop until start()', () => {
    const { host, frames, renderer } = fakeHost();
    let fail = true;
    host.onFrame(() => {
      if (fail) throw new Error('boom');
    });
    host.start();
    expect(() => frames.stepFrame()).toThrow('boom');
    expect(host.running).toBe(false);
    expect(frames.pendingCount).toBe(0);
    expect(renderer.renders).toHaveLength(0);
    expect(host.frame).toBe(0);

    fail = false;
    host.start();
    frames.stepFrame();
    expect(renderer.renders).toHaveLength(1);
    expect(host.running).toBe(true);
  });

  it('tells onFrameError what a frame threw, once the loop has stopped', () => {
    const heard: { error: unknown; running: boolean }[] = [];
    const { host, frames } = fakeHost(undefined, {
      onFrameError: (error, h) => heard.push({ error, running: h.running }),
    });
    const boom = new Error('boom');
    host.onFrame(() => {
      throw boom;
    });
    host.start();
    expect(() => frames.stepFrame()).toThrow('boom');
    expect(heard).toEqual([{ error: boom, running: false }]);
  });
});

describe('RenderHost resize and dispose', () => {
  it('resize calls setSize(w, h, false) and updates the camera aspect and projection', () => {
    const { host, renderer } = fakeHost();
    const project = vi.spyOn(host.camera, 'updateProjectionMatrix');
    host.resize(800, 400);
    expect(renderer.sizes.at(-1)).toEqual({ width: 800, height: 400, updateStyle: false });
    expect(host.camera.aspect).toBe(2);
    expect(project).toHaveBeenCalledTimes(1);
    const f = 1 / Math.tan((CAMERA_FOV * Math.PI) / 360);
    expect(host.camera.projectionMatrix.elements[0]).toBeCloseTo(f / 2, 12);

    host.resize(0, 300); // a hidden parent
    expect(renderer.sizes.at(-1)).toEqual({ width: 1, height: 300, updateStyle: false });
    expect(Number.isFinite(host.camera.aspect)).toBe(true);
  });

  it('width and height are the size last given, without reading the canvas', () => {
    const canvas = document.createElement('canvas');
    let reads = 0;
    Object.defineProperty(canvas, 'clientWidth', { get: () => (reads++, 640) });
    Object.defineProperty(canvas, 'clientHeight', { get: () => (reads++, 480) });
    const { host } = fakeHost(canvas);
    expect([host.width, host.height]).toEqual([640, 480]);
    const constructing = reads;
    host.resize(800, 0);
    expect([host.width, host.height]).toEqual([800, 1]);
    expect(reads).toBe(constructing);
  });

  it('a ResizeObserver on the canvas parent drives resize and is disconnected on dispose', () => {
    const observers: { cb: ResizeObserverCallback; targets: Element[]; disconnected: boolean }[] =
      [];
    class FakeResizeObserver {
      readonly record: (typeof observers)[number];
      constructor(cb: ResizeObserverCallback) {
        this.record = { cb, targets: [], disconnected: false };
        observers.push(this.record);
      }
      observe(target: Element): void {
        this.record.targets.push(target);
      }
      unobserve(): void {}
      disconnect(): void {
        this.record.disconnected = true;
      }
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    const parent = document.createElement('div');
    const canvas = document.createElement('canvas');
    parent.append(canvas);
    const { host, renderer } = fakeHost(canvas);
    expect(observers).toHaveLength(1);
    const observer = observers[0]!;
    expect(observer.targets).toEqual([parent]);

    const entry = { contentRect: { width: 1024, height: 512 } } as ResizeObserverEntry;
    observer.cb([entry], {} as ResizeObserver);
    expect(renderer.sizes.at(-1)).toEqual({ width: 1024, height: 512, updateStyle: false });
    expect(host.camera.aspect).toBe(2);

    host.dispose();
    expect(observer.disconnected).toBe(true);
  });

  it('a host-created renderer is disposed on dispose; a supplied renderer is not', () => {
    const canvas = document.createElement('canvas');
    const frames = new FrameDriver();
    const owned = new RenderHost({ canvas, raf: frames.raf, caf: frames.caf, now: frames.now });
    expect(mocks.created).toHaveLength(1);
    const created = mocks.created[0]!;
    expect(owned.renderer).toBe(created);
    expect(created.params).toEqual({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    owned.start();
    owned.dispose();
    owned.dispose();
    expect(created.disposeCalls).toBe(1);
    expect(owned.running).toBe(false);
    expect(frames.pendingCount).toBe(0);
    owned.start(); // no-op once disposed
    expect(frames.pendingCount).toBe(0);

    new RenderHost({ canvas, antialias: false });
    expect(mocks.created[1]?.params['antialias']).toBe(false);

    const { host, renderer, frames: suppliedFrames } = fakeHost();
    host.start();
    host.dispose();
    expect(renderer.disposeCalls).toBe(0);
    expect(suppliedFrames.pendingCount).toBe(0);
    expect(mocks.created).toHaveLength(2);
  });

  it('dispose from inside a frame callback skips that render', () => {
    const { host, frames, renderer } = fakeHost();
    host.onFrame(() => host.dispose());
    host.start();
    frames.stepFrame();
    expect(renderer.renders).toHaveLength(0);
    expect(host.frame).toBe(0);
    expect(frames.pendingCount).toBe(0);
  });
});

describe('statsHook', () => {
  it('reports fps from frame dt and the renderer and world counts every everyMs of frame time', () => {
    const { host, frames, world, fixture, renderer } = createWorld();
    fixture.snapshot(3, {
      creates: [
        { entity: 1, components: [regionOf('cell/0_0')] },
        { entity: 2, components: [regionOf('cell/0_0')] },
        { entity: 3, components: [regionOf('cell/2_1')] },
      ],
    });
    fixture.setRenderTick(3);
    host.setWorld(world);
    const material = new MeshBasicMaterial({ map: new Texture() });
    host.scene.add(new Mesh(new BoxGeometry(), material), new Mesh(new BoxGeometry(), material));
    const reports: RenderStats[] = [];
    const off = statsHook(host, world, (s) => reports.push(s));
    host.start();

    for (let i = 0; i < 14; i++) frames.stepFrame(20); // 280 ms: one report, after frame 13
    expect(reports).toHaveLength(1);
    const first = reports[0]!;
    expect(first.fps).toBeCloseTo(50, 9);
    expect(first).toMatchObject({
      dt: 0.02,
      calls: 2, // the previous frame's draw
      triangles: 24,
      geometries: 2,
      textures: 1,
      views: 3,
      regionGroups: 2,
      loaderInFlight: 0,
    });
    expect(renderer.info.render.calls).toBe(2);

    // The window restarted after the report: frame 14 (20 ms) + 100 + 100 + 29 = 249 ms, then 2 more.
    frames.stepFrame(100);
    frames.stepFrame(100);
    frames.stepFrame(29);
    expect(reports).toHaveLength(1);
    frames.stepFrame(2);
    expect(reports).toHaveLength(2);
    expect(reports[1]!.fps).toBeCloseTo(5 / 0.251, 9);
    expect(reports[1]!.dt).toBeCloseTo(0.002, 12);

    off();
    off();
    for (let i = 0; i < 30; i++) frames.stepFrame(20);
    expect(reports).toHaveLength(2);

    const every: RenderStats[] = [];
    statsHook(host, world, (s) => every.push(s), 0);
    frames.stepFrame(16);
    frames.stepFrame(16);
    expect(every.map((s) => s.fps)).toEqual([62.5, 62.5]);
  });

  it('loaderInFlight is the world loader stats().inFlight', () => {
    class BusyLoader extends AssetLoader {
      override stats(): ReturnType<AssetLoader['stats']> {
        return { queuedHigh: 4, queuedLow: 2, inFlight: 3, loaded: 9 };
      }
    }
    const manifest = { version: 1 as const, baseUrl: '/', assets: {}, groups: {}, regions: {} };
    const { host, frames, world } = createWorld(
      new ReplicaFixture(),
      {},
      new BusyLoader(manifest, []),
    );
    const reports: RenderStats[] = [];
    statsHook(host, world, (s) => reports.push(s), 0);
    host.start();
    frames.stepFrame();
    expect(reports.map((s) => s.loaderInFlight)).toEqual([3]);
  });
});

it('measures raw 200ms frames while animation dt stays clamped and GPU time stays unavailable', () => {
  const records: DiagnosticRecord[] = [];
  const { host, frames, world } = createWorld(new ReplicaFixture(), {
    diagnostics: {
      observer: { observe: (record) => records.push(record) },
      now: () => {
        throw Error('diagnostic clock');
      },
    },
  });
  const reports: RenderStats[] = [];
  statsHook(host, world, (report) => reports.push(report), 0);
  host.start();
  frames.stepFrame(200);
  expect(reports[0]).toMatchObject({ dt: MAX_DT, rawDt: 0.2, fps: 5 });
  expect(records.find((record) => record.category === 'frame')?.durationMs).toBe(200);
  expect(records.find((record) => record.category === 'gpu')).toMatchObject({
    status: 'unavailable',
    durationMs: undefined,
  });
  expect(host.running).toBe(true);
  host.dispose();
});

it('reports renderer context loss/restoration and removes diagnostic listeners on dispose', () => {
  const records: DiagnosticRecord[] = [];
  const { host } = fakeHost(sizedCanvas(200, 100), {
    diagnostics: { observer: { observe: (record) => records.push(record) }, now: () => 1 },
  });
  host.canvas.dispatchEvent(new Event('webglcontextlost'));
  host.canvas.dispatchEvent(new Event('webglcontextrestored'));
  expect(records.map((record) => record.name)).toEqual(['context-lost', 'context-restored']);
  host.dispose();
  host.canvas.dispatchEvent(new Event('webglcontextlost'));
  expect(records).toHaveLength(2);
});

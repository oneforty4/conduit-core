import type { BufferGeometry, Camera, Material, Mesh, Object3D, Texture } from 'three';
import type { RendererLike } from '../src/index.ts';

/**
 * `RendererLike` without WebGL (docs/render.md §9). `render` walks the visible scene the way
 * `WebGLRenderer` accounts for it: `info.render` counts meshes and triangles of the last frame, and
 * `info.memory` counts geometries and textures from the first frame that draws them until their
 * `dispose()` (it listens for the `dispose` event, as `WebGLRenderer` does).
 */
export class FakeRenderer implements RendererLike {
  readonly domElement: HTMLCanvasElement;
  readonly info = {
    memory: { geometries: 0, textures: 0 },
    render: { calls: 0, triangles: 0 },
  };
  /** Every `render` call, in order. */
  readonly renders: { scene: Object3D; camera: Camera }[] = [];
  /** Every `setSize` call, in order. */
  readonly sizes: { width: number; height: number; updateStyle: boolean | undefined }[] = [];
  pixelRatio = 1;
  disposeCalls = 0;
  private readonly geometries = new Set<BufferGeometry>();
  private readonly textures = new Set<Texture>();

  constructor(canvas: HTMLCanvasElement = document.createElement('canvas')) {
    this.domElement = canvas;
  }

  render(scene: Object3D, camera: Camera): void {
    this.renders.push({ scene, camera });
    this.info.render.calls = 0;
    this.info.render.triangles = 0;
    scene.traverseVisible((node) => {
      const mesh = node as Mesh;
      if (mesh.isMesh !== true) return;
      const geometry = mesh.geometry;
      this.trackGeometry(geometry);
      const vertices = geometry.index?.count ?? geometry.getAttribute('position')?.count ?? 0;
      this.info.render.calls += 1;
      this.info.render.triangles += Math.floor(vertices / 3);
      const materials: Material[] = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        for (const value of Object.values(material)) {
          if ((value as Texture | null)?.isTexture === true) this.trackTexture(value as Texture);
        }
      }
    });
  }

  setSize(width: number, height: number, updateStyle?: boolean): void {
    this.sizes.push({ width, height, updateStyle });
  }

  setPixelRatio(r: number): void {
    this.pixelRatio = r;
  }

  dispose(): void {
    this.disposeCalls += 1;
  }

  private trackGeometry(geometry: BufferGeometry): void {
    if (this.geometries.has(geometry)) return;
    this.geometries.add(geometry);
    this.info.memory.geometries += 1;
    const onDispose = (): void => {
      geometry.removeEventListener('dispose', onDispose);
      this.geometries.delete(geometry);
      this.info.memory.geometries -= 1;
    };
    geometry.addEventListener('dispose', onDispose);
  }

  private trackTexture(texture: Texture): void {
    if (this.textures.has(texture)) return;
    this.textures.add(texture);
    this.info.memory.textures += 1;
    const onDispose = (): void => {
      texture.removeEventListener('dispose', onDispose);
      this.textures.delete(texture);
      this.info.memory.textures -= 1;
    };
    texture.addEventListener('dispose', onDispose);
  }
}

/**
 * A manual `requestAnimationFrame` (docs/render.md §9): pass `raf`, `caf` and `now` to
 * `RenderHost`; nothing runs until `stepFrame`.
 */
export class FrameDriver {
  nowMs = 1000;
  private nextId = 1;
  private readonly pending = new Map<number, FrameRequestCallback>();

  readonly raf = (cb: FrameRequestCallback): number => {
    const id = this.nextId++;
    this.pending.set(id, cb);
    return id;
  };

  readonly caf = (id: number): void => {
    this.pending.delete(id);
  };

  readonly now = (): number => this.nowMs;

  /** Frame callbacks requested and not yet run or cancelled. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Advances `now` by `ms`, then runs the callbacks requested before this call that are still not
   * cancelled (a callback's own request waits for the next step). Returns how many ran.
   */
  stepFrame(ms = 1000 / 60): number {
    this.nowMs += ms;
    let ran = 0;
    for (const id of [...this.pending.keys()]) {
      const cb = this.pending.get(id);
      if (cb === undefined) continue;
      this.pending.delete(id);
      ran += 1;
      cb(this.nowMs);
    }
    return ran;
  }
}

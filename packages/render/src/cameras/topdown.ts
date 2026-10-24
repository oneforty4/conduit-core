import type { Vec3 } from '@conduit/math';
import { Vector3, type Object3D } from 'three';
import type { CameraContext, CameraController } from './context.ts';

export interface TopDownCameraOptions {
  /** Metres from the centre along the tilted view axis; default `TOPDOWN_HEIGHT_DEFAULT`. */
  height?: number;
  /** Radians from vertical (0 = straight down); default `TOPDOWN_TILT_DEFAULT`. */
  tilt?: number;
  /** Radians about +Y; 0 puts the camera on the centre's +Z side. Default 0. */
  yaw?: number;
  /** Default 10. */
  minHeight?: number;
  /** Default 500. */
  maxHeight?: number;
  /** Per wheel unit, multiplicative on `height`; default 0.001. */
  zoomSpeed?: number;
  /** 1/s; 0 = instant. Default 12. */
  smoothing?: number;
}

export const TOPDOWN_HEIGHT_DEFAULT = 60;
/** Radians from vertical. */
export const TOPDOWN_TILT_DEFAULT = 0.9;

const TOPDOWN_MIN_HEIGHT = 10;
const TOPDOWN_MAX_HEIGHT = 500;
const TOPDOWN_ZOOM_SPEED = 0.001;
const TOPDOWN_SMOOTHING = 12;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/**
 * Looks down at the camera target (or the scene origin) from `height` metres along a view axis
 * tilted `tilt` radians from vertical toward `yaw` (docs/render.md §6.3). The wheel zooms `height`
 * multiplicatively within its bounds; the position eases with `1 - exp(-smoothing * dt)`. Screen up
 * is the horizontal direction away from the camera (`yaw`), so a straight-down view (`tilt` 0) is
 * well defined. Works in scene space. Like `FollowCamera` it snaps instead of easing on `attach` and
 * whenever the centre changes source (a new target view, or between a target and the origin).
 */
export class TopDownCamera implements CameraController {
  private height: number;
  private readonly tilt: number;
  private readonly yaw: number;
  private readonly minHeight: number;
  private readonly maxHeight: number;
  private readonly zoomSpeed: number;
  private readonly smoothing: number;
  /** What `pos` eases around: the target object, `'origin'`, or null before the first placement. */
  private source: Object3D | 'origin' | null = null;
  private readonly pos = new Vector3();
  private readonly centre = new Vector3();
  private readonly desired = new Vector3();

  constructor(opts: TopDownCameraOptions = {}) {
    this.minHeight = opts.minHeight ?? TOPDOWN_MIN_HEIGHT;
    this.maxHeight = opts.maxHeight ?? TOPDOWN_MAX_HEIGHT;
    this.height = clamp(opts.height ?? TOPDOWN_HEIGHT_DEFAULT, this.minHeight, this.maxHeight);
    this.tilt = opts.tilt ?? TOPDOWN_TILT_DEFAULT;
    this.yaw = opts.yaw ?? 0;
    this.zoomSpeed = opts.zoomSpeed ?? TOPDOWN_ZOOM_SPEED;
    this.smoothing = opts.smoothing ?? TOPDOWN_SMOOTHING;
  }

  attach(ctx: CameraContext): void {
    this.source = null;
    this.follow(ctx, 0);
  }

  update(dt: number, ctx: CameraContext): void {
    this.height = clamp(
      this.height * (1 + ctx.input.wheelDelta() * this.zoomSpeed),
      this.minHeight,
      this.maxHeight,
    );
    this.follow(ctx, dt);
  }

  detach(): void {
    this.source = null;
  }

  /** Scene space moved by `-delta` (floating-origin change): shift the eased position. */
  rebase(delta: Vec3): void {
    this.pos.set(this.pos.x - delta.x, this.pos.y - delta.y, this.pos.z - delta.z);
  }

  /** Eases (or snaps, on a new centre source) toward centre + the tilted offset and aims. */
  private follow(ctx: CameraContext, dt: number): void {
    const centre = this.centre;
    const source = ctx.target !== null ? ctx.target.object : 'origin';
    if (source === 'origin') centre.set(0, 0, 0);
    else source.getWorldPosition(centre);
    const flat = this.height * Math.sin(this.tilt);
    const desired = this.desired.set(
      centre.x + flat * Math.sin(this.yaw),
      centre.y + this.height * Math.cos(this.tilt),
      centre.z + flat * Math.cos(this.yaw),
    );
    if (source !== this.source) {
      this.source = source;
      this.pos.copy(desired);
    } else {
      this.pos.lerp(desired, this.smoothing > 0 ? 1 - Math.exp(-this.smoothing * dt) : 1);
    }
    const camera = ctx.camera;
    camera.position.copy(this.pos);
    // Horizontal, pointing away from the camera: at rest this frames exactly as +Y up would for
    // 0 < tilt < π/2, but stays defined straight down and does not spin when a moving target passes
    // under a steep camera.
    camera.up.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    camera.lookAt(centre);
  }
}

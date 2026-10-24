import type { Vec3 } from '@conduit/math';
import { Vector3, type Object3D } from 'three';
import type { CameraContext, CameraController } from './context.ts';

export interface OrbitCameraOptions {
  /** Metres from the centre; default `ORBIT_DISTANCE_DEFAULT`, kept in `[minDistance, maxDistance]`. */
  distance?: number;
  /** Default 2. */
  minDistance?: number;
  /** Default 200. */
  maxDistance?: number;
  /** Radians about +Y; 0 puts the camera on the centre's +Z side. Default 0. */
  yaw?: number;
  /** Radians above the horizontal; default `ORBIT_PITCH_DEFAULT`, kept in `[minPitch, maxPitch]`. */
  pitch?: number;
  /** Default 0.05. */
  minPitch?: number;
  /** Default 1.5. */
  maxPitch?: number;
  /** Radians per pixel of drag; default `ORBIT_SENSITIVITY`. */
  sensitivity?: number;
  /** Per wheel unit, multiplicative: `distance *= 1 + delta * zoomSpeed`. Default `ORBIT_ZOOM_SPEED`. */
  zoomSpeed?: number;
  /** Pointer button that rotates while held; default 0. */
  dragButton?: 0 | 1 | 2;
  /** Fixed orbit centre in scene space, used while there is no target; default the origin. */
  point?: Vec3;
  /** 1/s; 0 = instant. Default `ORBIT_SMOOTHING`. */
  smoothing?: number;
}

export const ORBIT_DISTANCE_DEFAULT = 12;
export const ORBIT_PITCH_DEFAULT = 0.5;
/** Radians per pixel. */
export const ORBIT_SENSITIVITY = 0.005;
/** Per wheel `deltaY` unit, multiplicative. */
export const ORBIT_ZOOM_SPEED = 0.001;
/** 1/s. */
export const ORBIT_SMOOTHING = 12;

const ORBIT_MIN_DISTANCE = 2;
const ORBIT_MAX_DISTANCE = 200;
const ORBIT_MIN_PITCH = 0.05;
const ORBIT_MAX_PITCH = 1.5;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/**
 * Orbits the camera target (or a fixed `point`) at `distance`, `yaw` and `pitch` (docs/render.md
 * §6.2). Dragging with `dragButton` rotates (`yaw -= dx * sensitivity`, `pitch += dy * sensitivity`,
 * clamped); the wheel zooms multiplicatively within the distance bounds. The camera position eases
 * toward the orbit position with `1 - exp(-smoothing * dt)` and always looks at the centre. Works in
 * scene space. Like `FollowCamera` it snaps instead of easing on `attach` and whenever the centre
 * changes source (a new target view, or between a target and `point`).
 */
export class OrbitCamera implements CameraController {
  private distance: number;
  private yaw: number;
  private pitch: number;
  private readonly minDistance: number;
  private readonly maxDistance: number;
  private readonly minPitch: number;
  private readonly maxPitch: number;
  private readonly sensitivity: number;
  private readonly zoomSpeed: number;
  private readonly dragButton: 0 | 1 | 2;
  private readonly smoothing: number;
  private readonly point: Vector3;
  /** What `pos` eases around: the target object, `'point'`, or null before the first placement. */
  private source: Object3D | 'point' | null = null;
  private readonly pos = new Vector3();
  private readonly centre = new Vector3();
  private readonly desired = new Vector3();

  constructor(opts: OrbitCameraOptions = {}) {
    this.minDistance = opts.minDistance ?? ORBIT_MIN_DISTANCE;
    this.maxDistance = opts.maxDistance ?? ORBIT_MAX_DISTANCE;
    this.minPitch = opts.minPitch ?? ORBIT_MIN_PITCH;
    this.maxPitch = opts.maxPitch ?? ORBIT_MAX_PITCH;
    this.distance = clamp(
      opts.distance ?? ORBIT_DISTANCE_DEFAULT,
      this.minDistance,
      this.maxDistance,
    );
    this.pitch = clamp(opts.pitch ?? ORBIT_PITCH_DEFAULT, this.minPitch, this.maxPitch);
    this.yaw = opts.yaw ?? 0;
    this.sensitivity = opts.sensitivity ?? ORBIT_SENSITIVITY;
    this.zoomSpeed = opts.zoomSpeed ?? ORBIT_ZOOM_SPEED;
    this.dragButton = opts.dragButton ?? 0;
    this.smoothing = opts.smoothing ?? ORBIT_SMOOTHING;
    const point = opts.point ?? { x: 0, y: 0, z: 0 };
    this.point = new Vector3(point.x, point.y, point.z);
  }

  attach(ctx: CameraContext): void {
    this.source = null;
    this.follow(ctx, 0);
  }

  update(dt: number, ctx: CameraContext): void {
    const input = ctx.input;
    if (input.isPointerDown(this.dragButton)) {
      const d = input.pointerDelta();
      this.yaw -= d.x * this.sensitivity;
      this.pitch = clamp(this.pitch + d.y * this.sensitivity, this.minPitch, this.maxPitch);
    } else {
      input.pointerDelta(); // consume, so a later drag does not replay stale movement
    }
    this.distance = clamp(
      this.distance * (1 + input.wheelDelta() * this.zoomSpeed),
      this.minDistance,
      this.maxDistance,
    );
    this.follow(ctx, dt);
  }

  detach(): void {
    this.source = null;
  }

  /** Scene space moved by `-delta` (floating-origin change): shift the eased position and `point`. */
  rebase(delta: Vec3): void {
    this.pos.set(this.pos.x - delta.x, this.pos.y - delta.y, this.pos.z - delta.z);
    this.point.set(this.point.x - delta.x, this.point.y - delta.y, this.point.z - delta.z);
  }

  /** Eases (or snaps, on a new centre source) toward centre + the spherical offset and aims. */
  private follow(ctx: CameraContext, dt: number): void {
    const centre = this.centre;
    const source = ctx.target !== null ? ctx.target.object : 'point';
    if (source === 'point') centre.copy(this.point);
    else source.getWorldPosition(centre);
    const flat = this.distance * Math.cos(this.pitch);
    const desired = this.desired.set(
      centre.x + flat * Math.sin(this.yaw),
      centre.y + this.distance * Math.sin(this.pitch),
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
    camera.up.set(0, 1, 0);
    camera.lookAt(centre);
  }
}

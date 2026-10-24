import type { Vec3 } from '@conduit/math';
import { Quaternion, Vector3, type Object3D } from 'three';
import type { CameraContext, CameraController } from './context.ts';

export interface FollowCameraOptions {
  /** Target local space; default `FOLLOW_OFFSET_DEFAULT` (behind, since forward is +Z). */
  offset?: Vec3;
  /** 1/s; default `FOLLOW_STIFFNESS_DEFAULT`. */
  stiffness?: number;
  /** Seconds of target velocity added to the look point; default `FOLLOW_LOOK_AHEAD_DEFAULT`. */
  lookAhead?: number;
  /** Target local space; default `FOLLOW_LOOK_OFFSET_DEFAULT`. */
  lookOffset?: Vec3;
  /** Default `{ x: 0, y: 1, z: 0 }`. */
  up?: Vec3;
}

export const FOLLOW_OFFSET_DEFAULT: Readonly<Vec3> = Object.freeze({ x: 0, y: 6, z: -14 });
export const FOLLOW_STIFFNESS_DEFAULT = 8;
export const FOLLOW_LOOK_AHEAD_DEFAULT = 0.3;
export const FOLLOW_LOOK_OFFSET_DEFAULT: Readonly<Vec3> = Object.freeze({ x: 0, y: 1.5, z: 0 });

/** Lower bound on the `dt` that divides the target displacement into a velocity. */
const MIN_VELOCITY_DT = 1e-4;

/**
 * Chases a point at `offset` in the target's local frame with a critically damped spring and looks
 * at the target plus `lookOffset` plus `lookAhead` seconds of its velocity (docs/render.md §6.1).
 * Works in scene space. Snaps (no spring) when it first sees a target: on `attach` with a target, or
 * on the first `update` after the target view appeared or changed.
 */
export class FollowCamera implements CameraController {
  private readonly offset: Vector3;
  private readonly lookOffset: Vector3;
  private readonly up: Vector3;
  private readonly stiffness: number;
  private readonly lookAhead: number;
  private readonly pos = new Vector3();
  private readonly prevPos = new Vector3();
  private readonly vel = new Vector3();
  /** The target object the spring state belongs to; null until the next snap. */
  private followed: Object3D | null = null;
  private readonly tPos = new Vector3();
  private readonly tQuat = new Quaternion();
  private readonly tScale = new Vector3();
  private readonly desired = new Vector3();
  private readonly look = new Vector3();

  constructor(opts: FollowCameraOptions = {}) {
    const offset = opts.offset ?? FOLLOW_OFFSET_DEFAULT;
    const lookOffset = opts.lookOffset ?? FOLLOW_LOOK_OFFSET_DEFAULT;
    const up = opts.up ?? { x: 0, y: 1, z: 0 };
    this.offset = new Vector3(offset.x, offset.y, offset.z);
    this.lookOffset = new Vector3(lookOffset.x, lookOffset.y, lookOffset.z);
    this.up = new Vector3(up.x, up.y, up.z);
    this.stiffness = opts.stiffness ?? FOLLOW_STIFFNESS_DEFAULT;
    this.lookAhead = opts.lookAhead ?? FOLLOW_LOOK_AHEAD_DEFAULT;
  }

  attach(ctx: CameraContext): void {
    this.followed = null;
    if (ctx.target !== null) this.follow(ctx, ctx.target.object, 0);
  }

  update(dt: number, ctx: CameraContext): void {
    if (ctx.target === null) {
      this.followed = null; // the camera holds still; the next target snaps
      return;
    }
    this.follow(ctx, ctx.target.object, dt);
  }

  reset(): void {
    this.followed = null;
  }

  detach(): void {
    this.followed = null;
  }

  /** Scene space moved by `-delta` (floating-origin change): keeps the spring from jerking. */
  rebase(delta: Vec3): void {
    this.pos.set(this.pos.x - delta.x, this.pos.y - delta.y, this.pos.z - delta.z);
    this.prevPos.set(this.prevPos.x - delta.x, this.prevPos.y - delta.y, this.prevPos.z - delta.z);
  }

  private follow(ctx: CameraContext, target: Object3D, dt: number): void {
    target.updateWorldMatrix(true, false);
    target.matrixWorld.decompose(this.tPos, this.tQuat, this.tScale);
    const desired = this.desired.copy(this.offset).applyQuaternion(this.tQuat).add(this.tPos);
    if (target !== this.followed) {
      this.followed = target;
      this.pos.copy(desired);
      this.prevPos.copy(this.tPos);
      this.vel.set(0, 0, 0);
    } else {
      if (dt > 0) {
        this.vel.subVectors(this.tPos, this.prevPos).divideScalar(Math.max(dt, MIN_VELOCITY_DT));
      }
      this.prevPos.copy(this.tPos);
      // critically damped: x += (desired - x) * (1 - exp(-stiffness * dt)); never overshoots
      this.pos.lerp(desired, 1 - Math.exp(-this.stiffness * dt));
    }
    const look = this.look
      .copy(this.lookOffset)
      .applyQuaternion(this.tQuat)
      .add(this.tPos)
      .addScaledVector(this.vel, this.lookAhead);
    const camera = ctx.camera;
    camera.position.copy(this.pos);
    camera.up.copy(this.up);
    camera.lookAt(look);
  }
}

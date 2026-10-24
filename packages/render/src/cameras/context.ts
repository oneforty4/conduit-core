import type { PresentationPose } from '@conduit/net-client';
import type { DeepReadonly } from '@conduit/sim';
import type { Vec3 } from '@conduit/math';
import type { PerspectiveCamera } from 'three';
import type { EntityView } from '../view.ts';
import type { RenderWorld } from '../world.ts';

/** Supplied by the game; polled once per frame, never bound to the DOM here (docs/render.md §6). */
export interface InputSource {
  /** Pixels since the last call; resets on read. */
  pointerDelta(): { x: number; y: number };
  /** Sum of wheel `deltaY` since the last call; resets on read. */
  wheelDelta(): number;
  isPointerDown(button: 0 | 1 | 2): boolean;
  /** `KeyboardEvent.code`. */
  isKeyDown(code: string): boolean;
}

/** One object per `RenderWorld`, refreshed before every `CameraController.update`. */
export interface CameraContext {
  camera: PerspectiveCamera;
  world: RenderWorld;
  input: InputSource;
  /** The view of the entity named by `RenderWorld.cameraTarget`, or null while it has none. */
  target: EntityView | null;
  dt: number;
  presentation?: DeepReadonly<PresentationPose> | undefined;
}

/** Positions `ctx.camera` in scene space (floating-origin-relative), CONCEPT.md. */
export interface CameraController {
  attach(ctx: CameraContext): void;
  update(dt: number, ctx: CameraContext): void;
  detach(): void;
  /** Pose discontinuity; drop visual easing without changing authoritative/predicted state. */
  reset?(): void;
  /** Scene space moved by `-delta` (a floating-origin change, M3): shift internal positions. */
  rebase?(delta: Vec3): void;
}

/** All zeros and false: used when the game supplies no input. */
export const NULL_INPUT: InputSource = Object.freeze({
  pointerDelta: () => ({ x: 0, y: 0 }),
  wheelDelta: () => 0,
  isPointerDown: () => false,
  isKeyDown: () => false,
});

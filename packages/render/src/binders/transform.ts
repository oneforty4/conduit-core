import { Transform } from '@conduit/sim';
import { toThreeQuat } from '../math.ts';
import type { Binder, EntityView } from '../view.ts';
import { regionFrameOffset } from './region.ts';

type TransformValue = ReturnType<typeof Transform.create>;

/**
 * Writes the sampled (interpolated/extrapolated) `Transform.pos`/`rot` into `view.object`
 * (docs/render.md §4.1). Positions are region-local and the view is a child of its region group,
 * so the only origin math is `regionFrameOffset(view)`, non-zero only while an interpolation
 * bracket spans a migration (`RegionBinder`, which must be registered before this binder). `vel` is
 * ignored (extrapolation is `ReplicaWorld.sample`'s job).
 */
export class TransformBinder implements Binder<TransformValue> {
  readonly component = Transform;

  onUpdate(view: EntityView, t: Readonly<TransformValue>): void {
    const offset = regionFrameOffset(view);
    view.object.position.set(t.pos.x + offset.x, t.pos.y + offset.y, t.pos.z + offset.z);
    toThreeQuat(t.rot, view.object.quaternion);
  }
}

import type { EntityId } from '@conduit/sim';
import type { Transform } from '@conduit/sim';
import type { RegionId } from '@conduit/world';

/** All pose consumers share one sample and region-local coordinate frame per presentation frame. */
export interface PresentationPose {
  entity: EntityId;
  tick: number;
  regionId: RegionId;
  /** Change on teleport, generation replacement or another discontinuity requiring visual reset. */
  boundaryKey: string;
  transform: ReturnType<typeof Transform.create>;
}
export interface PresentationProvider {
  /** Called once before any entity/model/camera samples. Must not step persistent simulation. */
  beginFrame?(renderTick: number, nowMs: number): void;
  /** Writes a complete region-local pose into caller-owned output; false uses the authoritative replica. */
  sample(entity: EntityId, renderTick: number, out: PresentationPose): boolean;
}

import type { DeepReadonly } from '@conduit/sim';
import type { ComponentType, EntityId } from '@conduit/sim';
import type { RegionId } from '@conduit/world';
import type { Object3D } from 'three';
import type { ModelInstance } from './binders/model.ts';

/** The render-side counterpart of one visible replicated entity (docs/render.md §3.2). */
export interface EntityView {
  readonly id: EntityId;
  /**
   * The region whose group `object` is parented to: the entity's region at the render tick, kept
   * current by `RegionBinder` (docs/render.md §4.2).
   */
  regionId: RegionId;
  /** A `Group` named `entity:${id}`, child of `regionGroup(regionId)`. */
  readonly object: Object3D;
  /** Set by `ModelBinder` once the model resolved (M2). */
  model?: ModelInstance | undefined;
  /** Per-view scratch for binders. */
  readonly data: Record<string, unknown>;
  /** Binders currently attached (internal, exposed for tests). */
  readonly attached: Set<Binder<unknown>>;
}

/**
 * Binds one component type to a view (CONCEPT.md). `onAttach` runs once when the component appears
 * on a visible entity, `onUpdate` every frame while present (`interpolated` is true when `value` is
 * `ReplicaWorld.sample` output, i.e. the component's `interpolate` list is non-empty), `onDetach`
 * when the component is removed or the view is destroyed. Values are only valid during the call.
 */
export interface Binder<T> {
  component: ComponentType<T>;
  /**
   * Given its component's newest value as it comes, unsampled, attached while the replica has it:
   * for a binder that times its component itself (`RegionBinder`). Otherwise a binder sees its
   * component as of the render tick (docs/render.md §3.3).
   */
  newest?: boolean;
  onAttach?(view: EntityView, value: DeepReadonly<T>): void;
  onUpdate?(view: EntityView, value: DeepReadonly<T>, interpolated: boolean): void;
  onDetach?(view: EntityView): void;
}

import type { Binder, EntityView, ModelInstance, RenderWorld } from '@conduit/render';
import { Vehicle, type VehicleValue } from '../shared/components.ts';

// Only @conduit/render imports three (CONCEPT.md principle 1), so meshes and materials are handled
// through the structural subsets below instead of three's types.

/** The part of a Three `Material` with a `color` (e.g. `MeshStandardMaterial`) this binder uses. */
interface TintableMaterial {
  name: string;
  clone(): TintableMaterial;
  dispose(): void;
  color: { setHex(hex: number): unknown };
}

interface MeshLike {
  readonly isMesh?: boolean;
  material: unknown;
}

/** One mesh material slot this vehicle replaced with its own tinted copy. */
interface TintedSlot {
  mesh: MeshLike;
  /** Index into an array `material`, or null for a single material. */
  index: number | null;
  /** The shared material the slot held before, restored on release. */
  original: unknown;
}

/** A tinted object (the placeholder box or the model): its slots and this vehicle's copies. */
interface Tint {
  slots: TintedSlot[];
  /** Copies by original, so meshes sharing a material share one copy. */
  copies: Map<unknown, TintableMaterial>;
}

interface VehicleState {
  colour: number;
  /** The placeholder mesh tinted, while `ModelBinder`'s box shows. */
  placeholderMesh: MeshLike | null;
  placeholder: Tint | null;
  /** The resolved model tinted. */
  model: ModelInstance | null;
  modelTint: Tint | null;
}

const STATE_KEY = 'vehicleTint';
/** The name `ModelBinder` gives its placeholder (docs/render.md 4.3). */
const PLACEHOLDER_NAME = 'placeholder';
/** The body material of `assets/vehicle.glb` (scripts/make-models.py); the tyres stay black. */
export const PAINT_MATERIAL = 'paint';

function isTintable(material: unknown): material is TintableMaterial {
  const m = material as Partial<TintableMaterial> | null;
  return (
    typeof m === 'object' &&
    m !== null &&
    typeof m.clone === 'function' &&
    typeof m.dispose === 'function' &&
    typeof m.color?.setHex === 'function'
  );
}

function isMesh(node: unknown): node is MeshLike {
  return (node as MeshLike | null)?.isMesh === true;
}

/** `ModelBinder`'s placeholder box on `view`, when it is a mesh with a colour material. */
function placeholderMesh(view: EntityView): MeshLike | undefined {
  const node: unknown = view.object.getObjectByName(PLACEHOLDER_NAME);
  return isMesh(node) && isTintable(node.material) ? node : undefined;
}

function stateOf(view: EntityView): VehicleState | undefined {
  return view.data[STATE_KEY] as VehicleState | undefined;
}

/** Replaces every slot of `meshes` whose material `accept`s with a copy tinted `colour`. */
function tint(
  meshes: readonly MeshLike[],
  accept: (m: TintableMaterial) => boolean,
  colour: number,
): Tint {
  const result: Tint = { slots: [], copies: new Map() };
  const copyOf = (original: TintableMaterial): TintableMaterial => {
    let copy = result.copies.get(original);
    if (copy === undefined) {
      copy = original.clone();
      copy.color.setHex(colour);
      result.copies.set(original, copy);
    }
    return copy;
  };
  for (const mesh of meshes) {
    const material = mesh.material;
    if (Array.isArray(material)) {
      material.forEach((m: unknown, index) => {
        if (!isTintable(m) || !accept(m)) return;
        result.slots.push({ mesh, index, original: m });
        material[index] = copyOf(m);
      });
    } else if (isTintable(material) && accept(material)) {
      result.slots.push({ mesh, index: null, original: material });
      mesh.material = copyOf(material);
    }
  }
  return result;
}

/** Puts the original materials back (where the copies still sit) and disposes the copies. */
function untint(t: Tint): void {
  for (const { mesh, index, original } of t.slots) {
    const copy = t.copies.get(original);
    if (index === null) {
      if (mesh.material === copy) mesh.material = original;
    } else if (Array.isArray(mesh.material) && mesh.material[index] === copy) {
      mesh.material[index] = original;
    }
  }
  for (const copy of t.copies.values()) copy.dispose();
}

/**
 * Tints a vehicle with `Vehicle.colour` (PLAN.md "Sandbox content spec"): `ModelBinder`'s
 * placeholder box on attach, and on `modelReady` the model's `paint` material. Materials are shared
 * (all placeholders share one; a model's belong to its template, docs/render.md 4.3), so each
 * vehicle assigns its own copies and disposes them when the box goes, the model goes or the binder
 * detaches (which runs before `ModelBinder`'s). A colour change recolours the copies.
 *
 * `listen(world)` subscribes to `modelReady`; `onUpdate` also tints a model that resolved before the
 * binder attached, so the result does not depend on when `listen` is called.
 */
export class VehicleBinder implements Binder<VehicleValue> {
  readonly component = Vehicle;
  private readonly worlds = new Set<RenderWorld>();

  /** Tints models when `world` emits `modelReady`. Returns the unsubscribe; idempotent per world. */
  listen(world: RenderWorld): () => void {
    if (this.worlds.has(world)) return () => {};
    this.worlds.add(world);
    const off = world.on('modelReady', ({ view }) => {
      const state = stateOf(view);
      if (state !== undefined && view.attached.has(this)) this.sync(view, state);
    });
    return () => {
      off();
      this.worlds.delete(world);
    };
  }

  onAttach(view: EntityView, vehicle: Readonly<VehicleValue>): void {
    const state: VehicleState = {
      colour: vehicle.colour,
      placeholderMesh: null,
      placeholder: null,
      model: null,
      modelTint: null,
    };
    view.data[STATE_KEY] = state;
    this.sync(view, state);
  }

  onUpdate(view: EntityView, vehicle: Readonly<VehicleValue>): void {
    const state = stateOf(view);
    if (state === undefined) {
      this.onAttach(view, vehicle);
      return;
    }
    if (state.colour !== vehicle.colour) {
      state.colour = vehicle.colour;
      for (const t of [state.placeholder, state.modelTint]) {
        for (const copy of t?.copies.values() ?? []) copy.color.setHex(vehicle.colour);
      }
    }
    this.sync(view, state);
  }

  onDetach(view: EntityView): void {
    const state = stateOf(view);
    if (state === undefined) return;
    delete view.data[STATE_KEY];
    this.releasePlaceholder(state);
    this.releaseModel(state);
  }

  /** Brings the tints in line with what `view` shows now: its placeholder box and its model. */
  private sync(view: EntityView, state: VehicleState): void {
    const mesh = placeholderMesh(view) ?? null;
    if (mesh !== state.placeholderMesh) {
      this.releasePlaceholder(state);
      if (mesh !== null) {
        state.placeholderMesh = mesh;
        state.placeholder = tint([mesh], () => true, state.colour);
      }
    }
    const model = view.model ?? null;
    if (model !== state.model) {
      this.releaseModel(state);
      if (model !== null) {
        const meshes: MeshLike[] = [];
        model.root.traverse((node: unknown) => {
          if (isMesh(node)) meshes.push(node);
        });
        state.model = model;
        state.modelTint = tint(meshes, (m) => m.name === PAINT_MATERIAL, state.colour);
      }
    }
  }

  private releasePlaceholder(state: VehicleState): void {
    if (state.placeholder !== null) untint(state.placeholder);
    state.placeholder = null;
    state.placeholderMesh = null;
  }

  private releaseModel(state: VehicleState): void {
    if (state.modelTint !== null) untint(state.modelTint);
    state.modelTint = null;
    state.model = null;
  }
}

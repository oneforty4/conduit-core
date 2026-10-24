import type { RegionBounds, RegionId } from '@conduit/world';
import {
  BufferAttribute,
  BufferGeometry,
  LineBasicMaterial,
  LineSegments,
  type Object3D,
} from 'three';
import type { RenderWorld } from '../world.ts';

const REGION_BOUNDS_COLOR = 0x444444;
const REGION_BOUNDS_ACTIVE_COLOR = 0x00ff88;

interface Outline {
  /** The region group the line was added to; a new group for the same id gets a new line. */
  readonly group: Object3D;
  /** `null` for a node region, which has no extent. */
  readonly line: LineSegments<BufferGeometry, LineBasicMaterial> | null;
}

/** Corner pairs of the region's edges in region-local space; `null` for a node region. */
function edgePositions(bounds: RegionBounds): Float32Array | null {
  if (bounds.kind === 'node') return null;
  if (bounds.kind === 'aabb2') {
    const { min, max } = bounds;
    // Vec2.y is world z on the xz plane, world y on the xy plane; the third axis is drawn at 0.
    const corner = (u: number, v: number): number[] =>
      bounds.plane === 'xz' ? [u, 0, v] : [u, v, 0];
    const c0 = corner(min.x, min.y);
    const c1 = corner(max.x, min.y);
    const c2 = corner(max.x, max.y);
    const c3 = corner(min.x, max.y);
    return new Float32Array([c0, c1, c1, c2, c2, c3, c3, c0].flat());
  }
  const { min, max } = bounds;
  const xs = [min.x, max.x];
  const ys = [min.y, max.y];
  const zs = [min.z, max.z];
  const out: number[] = [];
  for (const y of ys) {
    for (const z of zs) out.push(min.x, y, z, max.x, y, z); // edges along x
  }
  for (const x of xs) {
    for (const z of zs) out.push(x, min.y, z, x, max.y, z); // along y
  }
  for (const x of xs) {
    for (const y of ys) out.push(x, y, min.z, x, y, max.z); // along z
  }
  return new Float32Array(out);
}

/**
 * Debug wireframes of region bounds (docs/render.md §8): one `LineSegments` per region group,
 * built from `graph.get(id).bounds` in region-local space and added to the group, so it follows the
 * floating origin. The floating region's outline uses `activeColor`. Node regions have no extent
 * and get no line. `update` (call it from `onFrame`) adds outlines for new groups, recolours, and
 * removes and disposes the outlines of released groups; `dispose` removes them all and disposes the
 * geometries and both materials.
 */
export class RegionBoundsHelper {
  private readonly world: RenderWorld;
  private readonly material: LineBasicMaterial;
  private readonly activeMaterial: LineBasicMaterial;
  private readonly outlines = new Map<RegionId, Outline>();
  private readonly present = new Set<RegionId>();
  private disposed = false;

  constructor(world: RenderWorld, opts: { color?: number; activeColor?: number } = {}) {
    this.world = world;
    this.material = new LineBasicMaterial({ color: opts.color ?? REGION_BOUNDS_COLOR });
    this.activeMaterial = new LineBasicMaterial({
      color: opts.activeColor ?? REGION_BOUNDS_ACTIVE_COLOR,
    });
  }

  /** Syncs the outlines with the region groups under `world.root`; a no-op after `dispose`. */
  update(): void {
    if (this.disposed) return;
    const world = this.world;
    const present = this.present;
    present.clear();
    for (const group of world.root.children) {
      const id: unknown = group.userData['regionId'];
      if (typeof id !== 'string') continue;
      present.add(id);
      let outline = this.outlines.get(id);
      if (outline !== undefined && outline.group !== group) {
        this.remove(id, outline);
        outline = undefined;
      }
      if (outline === undefined) {
        outline = this.build(id, group);
        this.outlines.set(id, outline);
      }
      if (outline.line !== null) {
        outline.line.material = id === world.floatingRegion ? this.activeMaterial : this.material;
      }
    }
    for (const [id, outline] of this.outlines) {
      if (!present.has(id)) this.remove(id, outline);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [id, outline] of this.outlines) this.remove(id, outline);
    this.material.dispose();
    this.activeMaterial.dispose();
  }

  private build(id: RegionId, group: Object3D): Outline {
    const bounds = this.world.graph.get(id)?.bounds;
    const positions = bounds === undefined ? null : edgePositions(bounds);
    if (positions === null) return { group, line: null };
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    const line = new LineSegments(geometry, this.material);
    line.name = 'region-bounds';
    group.add(line);
    return { group, line };
  }

  private remove(id: RegionId, outline: Outline): void {
    this.outlines.delete(id);
    if (outline.line === null) return;
    outline.line.removeFromParent();
    outline.line.geometry.dispose();
  }
}

import type { RegionDef, WorldGraph } from '@conduit/world';
import { LineSegments, type BufferGeometry, type LineBasicMaterial, type Object3D } from 'three';
import type { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EntityLabels,
  RegionBoundsHelper,
  RenderWorld,
  TransformBinder,
  type EntityView,
} from '../src/index.ts';
import { createWorld, FIXTURE_CELL_SIZE, regionOf, transformAt } from './replica-fixture.ts';

const DT = 1 / 60;
const CELL = FIXTURE_CELL_SIZE;

type Outline = LineSegments<BufferGeometry, LineBasicMaterial>;

function outlinesOf(group: Object3D): Outline[] {
  return group.children.filter((c): c is Outline => c.name === 'region-bounds');
}

function positionsOf(line: Outline): number[] {
  return [...(line.geometry.getAttribute('position').array as Float32Array)];
}

function colorOf(line: Outline): number {
  return line.material.color.getHex();
}

/** A `WorldGraph` over fixed defs: enough for helpers that only call `get`. */
function stubGraph(defs: RegionDef[]): WorldGraph {
  const byId = new Map(defs.map((d) => [d.id, d]));
  return {
    wantedDepth: 1,
    get: (id) => byId.get(id),
    neighbors: () => [],
    locate: () => null,
    wanted: (id) => [id],
    toJson: () => ({ version: 1, kind: 'node', regions: defs }),
  };
}

describe('RegionBoundsHelper', () => {
  it('outlines each region group in region-local space and highlights the floating region', () => {
    const { world } = createWorld();
    const a = world.regionGroup('cell/0_0');
    const b = world.regionGroup('cell/1_2');
    world.setFloatingOrigin('cell/1_2');
    const helper = new RegionBoundsHelper(world);
    expect(outlinesOf(a)).toEqual([]);

    helper.update();
    const [lineA] = outlinesOf(a);
    const [lineB] = outlinesOf(b);
    expect(lineA).toBeInstanceOf(LineSegments);
    // prettier-ignore
    expect(positionsOf(lineA!)).toEqual([
      0, 0, 0, CELL, 0, 0,   CELL, 0, 0, CELL, 0, CELL,
      CELL, 0, CELL, 0, 0, CELL,   0, 0, CELL, 0, 0, 0,
    ]);
    expect(colorOf(lineA!)).toBe(0x444444);
    expect(colorOf(lineB!)).toBe(0x00ff88);

    helper.update();
    expect(outlinesOf(a)).toEqual([lineA]);
    world.setFloatingOrigin('cell/0_0');
    helper.update();
    expect(colorOf(lineA!)).toBe(0x00ff88);
    expect(colorOf(lineB!)).toBe(0x444444);
    // Outlines hang under the groups, so root still holds exactly the region groups.
    expect(world.root.children).toEqual([a, b]);
  });

  it('disposes the outline of a released group, outlines its replacement, and disposes everything', () => {
    const { world } = createWorld();
    const group = world.regionGroup('cell/2_1');
    const helper = new RegionBoundsHelper(world, { color: 0x123456, activeColor: 0x654321 });
    helper.update();
    const [line] = outlinesOf(group);
    expect(colorOf(line!)).toBe(0x123456);
    const geometryDispose = vi.spyOn(line!.geometry, 'dispose');

    world.releaseRegionGroup('cell/2_1'); // an outline is not a view
    expect(world.hasRegionGroup('cell/2_1')).toBe(false);
    helper.update();
    expect(geometryDispose).toHaveBeenCalledTimes(1);
    expect(line!.parent).toBeNull();

    const replacement = world.regionGroup('cell/2_1');
    world.setFloatingOrigin('cell/2_1');
    helper.update();
    const [next] = outlinesOf(replacement);
    expect(next).not.toBe(line);
    expect(colorOf(next!)).toBe(0x654321);

    const disposals = [line!.material, next!.material, next!.geometry].map((o) =>
      vi.spyOn(o, 'dispose'),
    );
    helper.dispose();
    helper.dispose();
    expect(next!.parent).toBeNull();
    expect(disposals.map((spy) => spy.mock.calls.length)).toEqual([1, 1, 1]);
    helper.update();
    expect(outlinesOf(replacement)).toEqual([]);
  });

  it('draws aabb3 boxes and xy-plane rectangles; node regions get no outline', () => {
    const { host, fixture } = createWorld();
    const def = (id: string, bounds: RegionDef['bounds']): RegionDef => ({
      id,
      kind: 'test',
      bounds,
      neighbors: [],
      assets: [],
      seed: 1,
    });
    const origin = { x: 0, y: 0, z: 0 };
    const graph = stubGraph([
      def('box', {
        kind: 'aabb3',
        origin,
        min: { x: -1, y: -2, z: -3 },
        max: { x: 1, y: 2, z: 3 },
      }),
      def('wall', {
        kind: 'aabb2',
        origin,
        min: { x: 0, y: 0 },
        max: { x: 10, y: 5 },
        plane: 'xy',
      }),
      def('star', { kind: 'node', origin: { x: 1e6, y: 0, z: 0 } }),
    ]);
    const world = new RenderWorld(host, fixture.replica, fixture.clock, undefined, graph);
    const box = world.regionGroup('box');
    const wall = world.regionGroup('wall');
    const star = world.regionGroup('star');
    new RegionBoundsHelper(world).update();

    const boxPositions = positionsOf(outlinesOf(box)[0]!);
    expect(boxPositions).toHaveLength(12 * 2 * 3);
    const corners = new Set<string>();
    for (let i = 0; i < boxPositions.length; i += 6) {
      const a = boxPositions.slice(i, i + 3);
      const b = boxPositions.slice(i + 3, i + 6);
      corners.add(a.join()).add(b.join());
      // every edge runs along exactly one axis, the full extent of the box
      const lengths = a.map((v, axis) => Math.abs((b[axis] as number) - v)).filter((l) => l > 0);
      expect(lengths).toHaveLength(1);
      expect([2, 4, 6]).toContain(lengths[0]);
    }
    expect(corners.size).toBe(8);
    // prettier-ignore
    expect(positionsOf(outlinesOf(wall)[0]!)).toEqual([
      0, 0, 0, 10, 0, 0,   10, 0, 0, 10, 5, 0,
      10, 5, 0, 0, 5, 0,   0, 5, 0, 0, 0, 0,
    ]);
    expect(star.children).toEqual([]);
  });
});

describe('EntityLabels', () => {
  const containers: HTMLElement[] = [];
  afterEach(() => {
    for (const c of containers.splice(0)) c.remove();
  });

  function sizedContainer(width: number, height: number): HTMLElement {
    const container = document.createElement('div');
    Object.defineProperty(container, 'clientWidth', { value: width });
    Object.defineProperty(container, 'clientHeight', { value: height });
    document.body.appendChild(container);
    containers.push(container);
    return container;
  }

  function labelOf(view: EntityView): CSS2DObject | undefined {
    return view.object.children.find((c): c is CSS2DObject => c.name === 'label');
  }

  function texts(overlay: Element): (string | null)[] {
    return [...overlay.children].map((e) => e.textContent);
  }

  /** The pixel x of a label element's `translate(...px, ...px)`. */
  function screenX(element: Element): number {
    const m = /translate\((-?[\d.e+-]+)px,/.exec((element as HTMLElement).style.transform);
    if (m === null)
      throw new Error(`no pixel translate in ${(element as HTMLElement).style.transform}`);
    return Number(m[1]);
  }

  function scene(): ReturnType<typeof createWorld> {
    const s = createWorld();
    s.world.registerBinder(new TransformBinder());
    s.fixture.snapshot(3, {
      creates: [
        { entity: 1, components: [regionOf('cell/0_0'), transformAt({ x: 0, y: 0, z: 0 })] },
        { entity: 2, components: [regionOf('cell/0_0'), transformAt({ x: 5, y: 0, z: 0 })] },
      ],
    });
    s.fixture.setRenderTick(3);
    s.world.update(DT);
    s.host.camera.position.set(0, 20, 40);
    s.host.camera.lookAt(0, 0, 0);
    return s;
  }

  it('labels views by id, follows their creation and destruction, and projects them on render', () => {
    const { fixture, world, host } = scene();
    const container = sizedContainer(800, 600);
    const labels = new EntityLabels(world, container);
    const overlay = container.lastElementChild as HTMLElement;
    expect(overlay.className).toBe('conduit-labels');
    expect(overlay.style.pointerEvents).toBe('none');
    const view1 = world.view(1)!;
    expect(labelOf(view1)?.element.textContent).toBe('1');

    labels.render(host.camera);
    expect(texts(overlay)).toEqual(['1', '2']);
    const [first, second] = [...overlay.children];
    expect(screenX(first!)).toBeCloseTo(400, 6); // entity 1 is where the camera looks
    expect(screenX(second!)).toBeGreaterThan(400); // entity 2 is 5 m to the right
    expect(overlay.style.width).toBe('800px');

    fixture.snapshot(6, {
      creates: [
        { entity: 3, components: [regionOf('cell/0_0'), transformAt({ x: -5, y: 0, z: 0 })] },
      ],
      destroys: [1],
    });
    fixture.setRenderTick(6);
    world.update(DT);
    expect(labelOf(view1)).toBeUndefined();
    labels.render(host.camera);
    expect(texts(overlay)).toEqual(['2', '3']);

    labels.dispose();
    labels.dispose();
    expect(container.contains(overlay)).toBe(false);
    expect(labelOf(world.view(2)!)).toBeUndefined();
    fixture.snapshot(9, { creates: [{ entity: 4, components: [regionOf('cell/0_0')] }] });
    fixture.setRenderTick(9);
    world.update(DT);
    expect(labelOf(world.view(4)!)).toBeUndefined();
    labels.render(host.camera);
  });

  it('uses the text option and refreshes the text on every render', () => {
    const { world, host } = scene();
    let suffix = 'a';
    const labels = new EntityLabels(world, sizedContainer(100, 100), {
      text: (v) => `${v.id}@${v.regionId}:${suffix}`,
    });
    labels.render(host.camera);
    expect(labelOf(world.view(2)!)?.element.textContent).toBe('2@cell/0_0:a');
    suffix = 'b';
    labels.render(host.camera);
    expect(labelOf(world.view(2)!)?.element.textContent).toBe('2@cell/0_0:b');
    labels.dispose();
  });
});

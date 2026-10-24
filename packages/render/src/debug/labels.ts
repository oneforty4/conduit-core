import type { Camera } from 'three';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import type { EntityView } from '../view.ts';
import type { RenderWorld } from '../world.ts';

/**
 * Debug text labels over entity views (docs/render.md §8), drawn by a `CSS2DRenderer` whose overlay
 * element is appended to `container` (absolutely positioned at its top-left, sized to it, ignoring
 * pointer events; the container is usually the canvas's parent, covering the canvas). Each view
 * gets a `CSS2DObject` child named `label` at its origin whose text is `opts.text(view)` (default
 * `${id}`), refreshed on every `render`; labels follow `viewCreated`/`viewDestroyed`.
 */
export class EntityLabels {
  private readonly world: RenderWorld;
  private readonly container: HTMLElement;
  private readonly text: (v: EntityView) => string;
  private readonly css = new CSS2DRenderer();
  private readonly labels = new Map<EntityView, CSS2DObject>();
  private readonly offs: (() => void)[];
  private width = -1;
  private height = -1;
  private disposed = false;

  constructor(
    world: RenderWorld,
    container: HTMLElement,
    opts: { text?: (v: EntityView) => string } = {},
  ) {
    this.world = world;
    this.container = container;
    this.text = opts.text ?? ((v) => `${v.id}`);
    const overlay = this.css.domElement;
    overlay.className = 'conduit-labels';
    overlay.style.position = 'absolute';
    overlay.style.left = '0';
    overlay.style.top = '0';
    overlay.style.pointerEvents = 'none';
    container.appendChild(overlay);
    for (const view of world.views()) this.add(view);
    this.offs = [
      world.on('viewCreated', ({ view }) => this.add(view)),
      world.on('viewDestroyed', ({ view }) => this.remove(view)),
    ];
  }

  /** Refreshes the texts and positions the labels for `camera`; call after the render fn. */
  render(camera: Camera): void {
    if (this.disposed) return;
    for (const [view, label] of this.labels) {
      const text = this.text(view);
      if (label.element.textContent !== text) label.element.textContent = text;
    }
    const canvas = this.world.host.canvas;
    const width = this.container.clientWidth || canvas.clientWidth || 1;
    const height = this.container.clientHeight || canvas.clientHeight || 1;
    if (width !== this.width || height !== this.height) {
      this.width = width;
      this.height = height;
      this.css.setSize(width, height);
    }
    this.css.render(this.world.host.scene, camera);
  }

  /** Unsubscribes, removes every label and the overlay element. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.offs) off();
    for (const view of [...this.labels.keys()]) this.remove(view);
    this.css.domElement.remove();
  }

  private add(view: EntityView): void {
    if (this.labels.has(view)) return;
    const element = document.createElement('div');
    element.className = 'conduit-label';
    element.textContent = this.text(view);
    const label = new CSS2DObject(element);
    label.name = 'label';
    view.object.add(label);
    this.labels.set(view, label);
  }

  private remove(view: EntityView): void {
    const label = this.labels.get(view);
    if (label === undefined) return;
    this.labels.delete(view);
    label.removeFromParent(); // CSS2DObject removes its element on 'removed'
    label.element.remove(); // also when it had no parent any more
  }
}

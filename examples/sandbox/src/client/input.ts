import type { InputContext } from '@conduit/game/client';
import type { InputSource } from '@conduit/render';
import { INPUT_MAX } from '../shared/constants.ts';
import { BUTTON_HORN, type SandboxInput } from '../shared/input.ts';

/** `WheelEvent.deltaMode` line and page deltas in pixels, so the orbit zoom feels the same everywhere. */
const LINE_PIXELS = 16;

/** Key events aimed at a text field (the chat box) do not drive the vehicle or switch the camera. */
export function isTextEntry(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';
}

/** `+INPUT_MAX` while only `plus` is held, `-INPUT_MAX` while only `minus` is, else 0. */
function axis(down: ReadonlySet<string>, plus: string, minus: string): number {
  return (down.has(plus) ? INPUT_MAX : 0) - (down.has(minus) ? INPUT_MAX : 0);
}

/**
 * The browser's input. Keyboard state by `KeyboardEvent.code` is sampled once per sim tick into the
 * sandbox input frame: `W`/`S` throttle `+/-127`, `A`/`D` steer `-/+127` (positive steer turns
 * right), `Space` sets `BUTTON_HORN`. It is also the cameras' `InputSource`: pointer drags and the
 * wheel over `pointerTarget` (the canvas) rotate and zoom the `OrbitCamera`. Held keys and buttons
 * are released when the window loses focus or the page is hidden.
 */
export class BrowserInput implements InputSource {
  private readonly down = new Set<string>();
  private readonly buttons = new Set<number>();
  private readonly frame: SandboxInput = { tick: 0, throttle: 0, steer: 0, buttons: 0 };
  private readonly delta = { x: 0, y: 0 };
  private wheel = 0;
  private lastX = 0;
  private lastY = 0;
  private readonly target: Window;
  private readonly pointerTarget: HTMLElement;

  constructor(target: Window, pointerTarget: HTMLElement) {
    this.target = target;
    this.pointerTarget = pointerTarget;
    target.addEventListener('keydown', this.onKeyDown);
    target.addEventListener('keyup', this.onKeyUp);
    target.addEventListener('blur', this.releaseAll);
    target.document.addEventListener('visibilitychange', this.onVisibility);
    pointerTarget.addEventListener('pointerdown', this.onPointerDown);
    pointerTarget.addEventListener('pointermove', this.onPointerMove);
    pointerTarget.addEventListener('pointerup', this.onPointerUp);
    pointerTarget.addEventListener('pointercancel', this.onPointerUp);
    pointerTarget.addEventListener('wheel', this.onWheel, { passive: true });
  }

  /** `CreateClientOpts.sampleInput`: the returned object is reused (the client copies it). */
  sample(ctx: InputContext<SandboxInput>): SandboxInput {
    const frame = this.frame;
    frame.tick = ctx.tick;
    frame.throttle = axis(this.down, 'KeyW', 'KeyS');
    frame.steer = axis(this.down, 'KeyD', 'KeyA');
    frame.buttons = this.down.has('Space') ? BUTTON_HORN : 0;
    return frame;
  }

  isKeyDown(code: string): boolean {
    return this.down.has(code);
  }

  pointerDelta(): { x: number; y: number } {
    const out = { x: this.delta.x, y: this.delta.y };
    this.delta.x = 0;
    this.delta.y = 0;
    return out;
  }

  wheelDelta(): number {
    const out = this.wheel;
    this.wheel = 0;
    return out;
  }

  isPointerDown(button: 0 | 1 | 2): boolean {
    return this.buttons.has(button);
  }

  dispose(): void {
    const { target, pointerTarget } = this;
    target.removeEventListener('keydown', this.onKeyDown);
    target.removeEventListener('keyup', this.onKeyUp);
    target.removeEventListener('blur', this.releaseAll);
    target.document.removeEventListener('visibilitychange', this.onVisibility);
    pointerTarget.removeEventListener('pointerdown', this.onPointerDown);
    pointerTarget.removeEventListener('pointermove', this.onPointerMove);
    pointerTarget.removeEventListener('pointerup', this.onPointerUp);
    pointerTarget.removeEventListener('pointercancel', this.onPointerUp);
    pointerTarget.removeEventListener('wheel', this.onWheel);
    this.releaseAll();
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (isTextEntry(event.target)) return;
    this.down.add(event.code);
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.down.delete(event.code);
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    this.buttons.add(event.button);
    this.lastX = event.clientX;
    this.lastY = event.clientY;
    try {
      this.pointerTarget.setPointerCapture(event.pointerId); // keep receiving moves while dragging
    } catch {
      // an unknown pointer id (or no capture support): drags then end at the element's edge
    }
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    this.delta.x += event.clientX - this.lastX;
    this.delta.y += event.clientY - this.lastY;
    this.lastX = event.clientX;
    this.lastY = event.clientY;
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    this.buttons.delete(event.button);
  };

  private readonly onWheel = (event: WheelEvent): void => {
    const scale =
      event.deltaMode === 1 ? LINE_PIXELS : event.deltaMode === 2 ? this.target.innerHeight : 1;
    this.wheel += event.deltaY * scale;
  };

  private readonly releaseAll = (): void => {
    this.down.clear();
    this.buttons.clear();
    this.delta.x = 0;
    this.delta.y = 0;
    this.wheel = 0;
  };

  private readonly onVisibility = (): void => {
    if (this.target.document.visibilityState === 'hidden') this.releaseAll();
  };
}

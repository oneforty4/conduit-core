// Browser-side sandbox pieces in jsdom, with structural stand-ins for three objects (tests may not
// import three): VehicleBinder tints, the chat box, the grace timers behind debug.expireGrace, the
// `window.__conduit` region and position helpers, the HUD's region list, region groups and the orbit
// camera's pointer and wheel input.
import type { ConnectResult, FrameContext, GameClient } from '@conduit/game/client';
import type { EntityView, ModelInstance, RenderWorld, RenderWorldEvents } from '@conduit/render';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PAINT_MATERIAL, VehicleBinder } from '../src/client/binders.ts';
import { CHAT_LOG_LINES, ChatBox } from '../src/client/chat.ts';
import { GraceTimers, installDebug } from '../src/client/debug.ts';
import {
  BYTES_REFRESH_S,
  type ByteRates,
  Hud,
  HUD_IDS,
  summarizeRegions,
  type FrameRegions,
} from '../src/client/hud.ts';
import { BrowserInput } from '../src/client/input.ts';
import { RegionGroups, type RegionGroupWorld } from '../src/client/regions.ts';
import { game } from '../src/shared/game.ts';
import type { SandboxInput } from '../src/shared/input.ts';

class FakeColor {
  hex = 0xcccccc;
  setHex(hex: number): this {
    this.hex = hex;
    return this;
  }
}

class FakeMaterial {
  readonly color = new FakeColor();
  disposed = 0;
  constructor(readonly name: string) {}
  clone(): FakeMaterial {
    const copy = new FakeMaterial(this.name);
    copy.color.hex = this.color.hex;
    return copy;
  }
  dispose(): void {
    this.disposed += 1;
  }
}

interface FakeNode {
  name: string;
  isMesh?: boolean;
  material?: unknown;
  children: FakeNode[];
}

function node(name: string, children: FakeNode[] = [], material?: unknown): FakeNode {
  return material === undefined ? { name, children } : { name, isMesh: true, material, children };
}

function traverse(n: FakeNode, cb: (n: FakeNode) => void): void {
  cb(n);
  for (const c of n.children) traverse(c, cb);
}

/** An entity view whose object holds `children` (e.g. the placeholder). */
function view(children: FakeNode[] = []): EntityView {
  const object = node('entity:1', children);
  return {
    id: 1,
    regionId: 'cell/8_8',
    object: {
      getObjectByName: (name: string) => {
        let found: FakeNode | undefined;
        traverse(object, (n) => {
          if (found === undefined && n.name === name) found = n;
        });
        return found;
      },
      children: object.children,
    },
    data: {},
    attached: new Set(),
  } as unknown as EntityView;
}

/** A model whose LOD levels share the template's `paint` and `tyre` materials. */
function model(paint: FakeMaterial, tyre: FakeMaterial): ModelInstance {
  const root = node('vehicle', [
    node('vehicle_LOD', [
      node('vehicle_LOD0', [node('body', [], paint), node('wheels', [], tyre)]),
      node('vehicle_LOD1', [], [paint, tyre]),
      node('vehicle_LOD2', [], paint),
    ]),
    node('vehicle_COL_box', [], new FakeMaterial('')),
  ]);
  return {
    root: { traverse: (cb: (n: FakeNode) => void) => traverse(root, cb) },
  } as unknown as ModelInstance;
}

function fakeWorld(): {
  world: RenderWorld;
  emit: (e: RenderWorldEvents['modelReady']) => void;
  listeners: unknown[];
} {
  const listeners: ((e: RenderWorldEvents['modelReady']) => void)[] = [];
  const world = {
    on: (k: string, cb: (e: RenderWorldEvents['modelReady']) => void) => {
      if (k === 'modelReady') listeners.push(cb);
      return () => listeners.splice(listeners.indexOf(cb), 1);
    },
  } as unknown as RenderWorld;
  return { world, emit: (e) => listeners.forEach((cb) => cb(e)), listeners };
}

const RED = 0xe6194b;
const BLUE = 0x4363d8;
const vehicle = (colour: number) => ({ throttle: 0, steer: 0, buttons: 0, colour });

describe('VehicleBinder', () => {
  it('tints its own copy of the placeholder material and restores the shared one on detach', () => {
    const shared = new FakeMaterial('');
    const placeholder = node('placeholder', [], shared);
    const v = view([placeholder]);
    const binder = new VehicleBinder();
    v.attached.add(binder);
    binder.onAttach(v, vehicle(RED));
    const copy = placeholder.material as FakeMaterial;
    expect(copy).not.toBe(shared);
    expect(copy.color.hex).toBe(RED);
    expect(shared.color.hex).toBe(0xcccccc);
    binder.onUpdate(v, vehicle(BLUE));
    expect(placeholder.material).toBe(copy);
    expect(copy.color.hex).toBe(BLUE);
    binder.onDetach(v);
    expect(placeholder.material).toBe(shared);
    expect(copy.disposed).toBe(1);
    expect(v.data).toEqual({});
  });

  it("on modelReady tints one copy per shared paint material, leaves the tyres, and releases the box's copy", () => {
    const { world, emit, listeners } = fakeWorld();
    const binder = new VehicleBinder();
    const off = binder.listen(world);
    binder.listen(world); // idempotent per world
    expect(listeners).toHaveLength(1);
    const shared = new FakeMaterial('');
    const children = [node('placeholder', [], shared)];
    const v = view(children);
    v.attached.add(binder);
    binder.onAttach(v, vehicle(RED));
    const boxCopy = children[0]?.material as FakeMaterial;

    // ModelBinder swaps the box for the model, then emits modelReady.
    children.splice(0, 1);
    const paint = new FakeMaterial(PAINT_MATERIAL);
    const tyre = new FakeMaterial('tyre');
    const m = model(paint, tyre);
    v.model = m;
    emit({ view: v, model: m });

    const meshes: FakeNode[] = [];
    (m.root as unknown as { traverse: (cb: (n: FakeNode) => void) => void }).traverse((n) => {
      if (n.isMesh === true) meshes.push(n);
    });
    const slots = meshes.flatMap((n) => (Array.isArray(n.material) ? n.material : [n.material]));
    const paints = slots.filter((mat) => (mat as FakeMaterial).name === PAINT_MATERIAL);
    expect(paints).toHaveLength(3);
    expect(new Set(paints).size).toBe(1); // meshes sharing the template's paint share one copy
    const paintCopy = paints[0] as FakeMaterial;
    expect(paintCopy).not.toBe(paint);
    expect(paintCopy.color.hex).toBe(RED);
    expect(paint.color.hex).toBe(0xcccccc); // the template is untouched
    expect(slots.filter((mat) => mat === tyre)).toHaveLength(2);
    expect(boxCopy.disposed).toBe(1);

    binder.onUpdate(v, vehicle(BLUE));
    expect(paintCopy.color.hex).toBe(BLUE);
    binder.onDetach(v);
    const restored = meshes.flatMap((n) => (Array.isArray(n.material) ? n.material : [n.material]));
    expect(restored.filter((mat) => mat === paint)).toHaveLength(3);
    expect(paintCopy.disposed).toBe(1);

    // A model that resolved before the binder attached is tinted by onAttach itself.
    const late = view();
    late.model = model(paint, tyre);
    late.attached.add(binder);
    binder.onAttach(late, vehicle(BLUE));
    let tinted = 0;
    (late.model.root as unknown as { traverse: (cb: (n: FakeNode) => void) => void }).traverse(
      (n) => {
        if (n.isMesh === true && (n.material as FakeMaterial).color?.hex === BLUE) tinted += 1;
      },
    );
    expect(tinted).toBe(2); // body and LOD2; LOD1's array slot holds the third copy
    off();
    expect(listeners).toHaveLength(0);
  });
});

describe('ChatBox', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  function setup(): {
    box: ChatBox;
    sent: { text: string }[];
    input: HTMLInputElement;
    log: HTMLElement;
  } {
    document.body.innerHTML = '<ol id="chat-log"></ol><input id="chat-input" />';
    const sent: { text: string }[] = [];
    const box = new ChatBox(document, (msg) => sent.push(msg));
    return {
      box,
      sent,
      input: document.getElementById('chat-input') as HTMLInputElement,
      log: document.getElementById('chat-log') as HTMLElement,
    };
  }

  const key = (target: EventTarget, k: string) =>
    target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

  it('sends trimmed text clipped to 200 UTF-8 bytes on Enter, ignores blank lines and focuses on Enter', () => {
    const { box, sent, input } = setup();
    key(document.body, 'Enter');
    expect(document.activeElement).toBe(input);
    input.value = '  hi there  ';
    key(input, 'Enter');
    input.value = '   ';
    key(input, 'Enter');
    input.value = '\u{E9}'.repeat(150); // 300 bytes
    key(input, 'Enter');
    expect(sent.map((m) => m.text)).toEqual(['hi there', '\u{E9}'.repeat(100)]);
    expect(input.value).toBe('');
    key(input, 'Escape');
    expect(document.activeElement).not.toBe(input);
    box.dispose();
  });

  it('appends broadcast lines as text, keeping the newest CHAT_LOG_LINES', () => {
    const { box, log } = setup();
    box.append({ text: '<b>alice</b>: hi' });
    expect(log.textContent).toBe('<b>alice</b>: hi');
    expect(log.querySelector('b')).toBeNull();
    for (let i = 0; i < CHAT_LOG_LINES + 5; i++) box.append({ text: `line ${i}` });
    expect(log.childElementCount).toBe(CHAT_LOG_LINES);
    expect(log.lastElementChild?.textContent).toBe(`line ${CHAT_LOG_LINES + 4}`);
    box.append({ nope: true });
    expect(log.childElementCount).toBe(CHAT_LOG_LINES);
    box.dispose();
  });
});

describe('GraceTimers', () => {
  it('runs every pending timer at once, including timers they set, and forgets cleared ones', () => {
    vi.useFakeTimers();
    try {
      const timers = new GraceTimers();
      const ran: string[] = [];
      timers.set(() => {
        ran.push('a');
        timers.set(() => ran.push('a-dep'), 5000);
      }, 5000);
      const cleared = timers.set(() => ran.push('cleared'), 5000);
      timers.set(() => ran.push('b'), 5000);
      timers.clear(cleared);
      timers.clear(undefined);
      expect(timers.size).toBe(2);
      expect(timers.expireAll()).toBe(3);
      expect(ran).toEqual(['a', 'b', 'a-dep']);
      expect(timers.size).toBe(0);
      vi.advanceTimersByTime(10_000); // the real timeouts were cancelled
      expect(ran).toHaveLength(3);
      timers.set(() => ran.push('late'), 100);
      vi.advanceTimersByTime(100);
      expect(ran.at(-1)).toBe('late');
      expect(timers.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

function regions(parts: Partial<FrameRegions>): FrameRegions {
  return { loaded: [], loading: [], wanted: [], prefetch: [], ...parts };
}

/** An element for every HUD id. */
function hudMarkup(): string {
  return Object.values(HUD_IDS)
    .map((id) => `<div id="${id}"></div>`)
    .join('');
}

describe('Hud connection fields', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  const frame = (dt: number) =>
    ({
      renderTick: 10,
      dt,
      clock: { rttMs: 12 },
      replica: { visibleAt: () => [] },
      localEntity: undefined,
      input: undefined,
      regions: regions({}),
    }) as unknown as FrameContext<SandboxInput>;

  it('shows bytes in and out per second from the net stats, refreshed every BYTES_REFRESH_S', () => {
    document.body.innerHTML = hudMarkup();
    const hud = new Hud(document);
    const el = document.getElementById(HUD_IDS.bytes) as HTMLElement;
    let rates: ByteRates = { bytesInPerSec: 6612.4, bytesOutPerSec: 3700 };
    let reads = 0;
    const net = {
      stats: () => {
        reads++;
        return rates;
      },
    };
    hud.update(frame(0));
    expect(reads).toBe(0); // no net stats given: the field is left alone
    hud.update(frame(0), net);
    expect(el.textContent).toBe('in 6.6 KB/s, out 3.7 KB/s');
    expect({ ...el.dataset }).toEqual({ in: '6612', out: '3700' });

    rates = { bytesInPerSec: 12_345, bytesOutPerSec: 0 };
    const step = BYTES_REFRESH_S * 0.4;
    hud.update(frame(step), net);
    hud.update(frame(step), net);
    expect(reads).toBe(1);
    expect(el.textContent).toBe('in 6.6 KB/s, out 3.7 KB/s');
    hud.update(frame(step), net);
    expect(reads).toBe(2);
    expect(el.textContent).toBe('in 12.3 KB/s, out 0.0 KB/s');
    expect({ ...el.dataset }).toEqual({ in: '12345', out: '0' });
  });

  it("shows the join counter, keeps 'reconnecting' while a loss is retried and the close once it is final", () => {
    document.body.innerHTML = hudMarkup();
    const hud = new Hud(document);
    const joins = document.getElementById(HUD_IDS.joins) as HTMLElement;
    hud.setJoins(3);
    expect(joins.textContent).toBe('3');
    expect(joins.dataset['total']).toBe('3');

    const state = document.getElementById(HUD_IDS.state) as HTMLElement;
    hud.setState('spawned');
    // GameClient emits the state change, then 'disconnected' with willReconnect.
    hud.setState('reconnecting');
    hud.setDisconnected({ code: 1006, reason: '', willReconnect: true });
    expect(state.textContent).toBe('reconnecting');
    hud.setState('spawned');
    expect(state.textContent).toBe('spawned');

    hud.setState('closed');
    hud.setDisconnected({ code: 1006, reason: 'transport error', willReconnect: false });
    expect(state.textContent).toBe('closed (1006 transport error)');
    hud.setFinal('Rejected: SchemaMismatch \u{2014} please refresh');
    hud.setState('connecting');
    hud.setDisconnected({ code: 4005, reason: '', willReconnect: false });
    expect(state.textContent).toBe('Rejected: SchemaMismatch \u{2014} please refresh');
  });
});

describe('Hud regions', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('counts and lists the loaded, loading and releasing ids, with the counts as data attributes', () => {
    document.body.innerHTML = hudMarkup();
    const hud = new Hud(document);
    const el = document.getElementById('hud-regions') as HTMLElement;
    const frame = (r: FrameRegions) =>
      ({
        renderTick: 10,
        dt: 0.016,
        clock: { rttMs: 12 },
        replica: { visibleAt: () => [] },
        localEntity: undefined,
        input: undefined,
        regions: r,
      }) as unknown as FrameContext<SandboxInput>;

    // cell/8_6 left the set (release grace), cell/8_11 is prefetched but still loading.
    const moved = regions({
      loaded: ['cell/8_10', 'cell/8_6', 'cell/8_8', 'cell/8_9'],
      loading: ['cell/8_11'],
      wanted: ['cell/8_8', 'cell/8_9'],
      prefetch: ['cell/8_10', 'cell/8_11'],
    });
    expect(summarizeRegions(moved)).toEqual({
      loaded: ['cell/8_10', 'cell/8_8', 'cell/8_9'],
      loading: ['cell/8_11'],
      releasing: ['cell/8_6'],
    });
    hud.update(frame(moved));
    expect(el.textContent).toBe(
      [
        '3 loaded, 1 loading, 1 releasing',
        'loaded: cell/8_10 cell/8_8 cell/8_9',
        'loading: cell/8_11',
        'releasing: cell/8_6',
      ].join('\n'),
    );
    expect({ ...el.dataset }).toEqual({ loaded: '3', loading: '1', releasing: '1', wanted: '2' });

    const settled = regions({
      loaded: ['cell/8_10', 'cell/8_11', 'cell/8_8', 'cell/8_9'],
      wanted: ['cell/8_8', 'cell/8_9'],
      prefetch: ['cell/8_10', 'cell/8_11'],
    });
    hud.update(frame(settled));
    expect(el.textContent).toBe(
      ['4 loaded, 0 loading', 'loaded: cell/8_10 cell/8_11 cell/8_8 cell/8_9'].join('\n'),
    );
    expect(el.dataset['releasing']).toBe('0');
    // A dropped region that was still loading is releasing too.
    expect(summarizeRegions(regions({ loading: ['cell/1_1'] }))).toEqual({
      loaded: [],
      loading: [],
      releasing: ['cell/1_1'],
    });
  });
});

describe('RegionGroups', () => {
  function world(): RegionGroupWorld & { groups: Set<string>; occupied: Set<string> } {
    const groups = new Set<string>();
    const occupied = new Set<string>();
    return {
      groups,
      occupied,
      regionGroup: (id) => groups.add(id),
      hasRegionGroup: (id) => groups.has(id),
      releaseRegionGroup: (id) => {
        if (!occupied.has(id)) groups.delete(id);
      },
    };
  }

  it('keeps a group per held region and releases it once the region is gone and its views left', () => {
    const w = world();
    const sync = new RegionGroups();
    w.groups.add('cell/0_0'); // somebody else's group
    sync.sync(w, ['cell/8_8', 'cell/8_9'], ['cell/8_10']);
    expect([...w.groups].sort()).toEqual(['cell/0_0', 'cell/8_10', 'cell/8_8', 'cell/8_9']);

    w.occupied.add('cell/8_8'); // a view is still in it
    sync.sync(w, ['cell/8_9'], ['cell/8_10']);
    expect([...w.groups].sort()).toEqual(['cell/0_0', 'cell/8_10', 'cell/8_8', 'cell/8_9']);
    expect(sync.pendingReleases).toBe(1);
    w.occupied.clear();
    const same = { loaded: ['cell/8_9'], loading: ['cell/8_10'] };
    sync.sync(w, same.loaded, same.loading); // retried every frame
    expect([...w.groups].sort()).toEqual(['cell/0_0', 'cell/8_10', 'cell/8_9']);
    expect(sync.pendingReleases).toBe(0);

    // Held again before its release: the group stays.
    w.occupied.add('cell/8_9');
    sync.sync(w, [], []);
    expect(sync.pendingReleases).toBe(1);
    sync.sync(w, ['cell/8_9'], []);
    expect(sync.pendingReleases).toBe(0);
    expect(w.groups.has('cell/8_9')).toBe(true);
    expect(w.groups.has('cell/0_0')).toBe(true);
  });
});

describe('window.__conduit', () => {
  afterEach(() => {
    delete window.__conduit;
  });

  it('reports no regions before the NetClient exists, then its loaded ones, and positions from the view', async () => {
    const graph = game.world(game.seed);
    let loaded: string[] | null = null;
    const client = {
      state: 'connecting',
      localEntity: 7,
      get net() {
        if (loaded === null) throw new Error('GameClient.net: call connect() first');
        return {};
      },
      get regions() {
        if (loaded === null) throw new Error('GameClient.regions: call connect() first');
        const ids = loaded;
        return { loaded: () => ids };
      },
    } as unknown as GameClient<SandboxInput>;
    let connected!: (r: ConnectResult) => void;
    const connecting = new Promise<ConnectResult>((resolve) => {
      connected = resolve;
    });
    const hook = installDebug(client, connecting, new GraceTimers());
    const debug = window.__conduit;
    if (debug === undefined) throw new Error('no window.__conduit');
    expect(debug.regionsLoaded()).toEqual([]);
    expect(debug.replicaCount()).toBe(0);
    expect(debug.localPosition()).toBeNull();

    loaded = ['cell/8_8', 'cell/8_9'];
    expect(debug.regionsLoaded()).toEqual(['cell/8_8', 'cell/8_9']);

    // The vehicle is drawn 3 m past the border of cell/8_9, which its view is in; the replica's
    // newest Region and Transform are not consulted.
    const views = new Map([
      [7, { regionId: 'cell/8_9', object: { position: { x: 5, y: 0, z: 3 } } }],
    ]);
    const world = { graph, view: (e: number) => views.get(e) } as unknown as RenderWorld;
    hook({ render: { host: {}, world }, localEntity: 7 } as unknown as FrameContext<SandboxInput>);
    expect(debug.world).toBe(world);
    expect(debug.localPosition()).toEqual({ x: 2048 + 5, y: 0, z: 2304 + 3 });

    connected({ playerId: 0, localEntity: 7, tick: 1 });
    await Promise.resolve();
    hook({ render: { host: {}, world }, localEntity: 7 } as unknown as FrameContext<SandboxInput>);
    await expect(debug.ready).resolves.toBeUndefined();
  });
});

describe('BrowserInput', () => {
  it('reports drag deltas, buttons and wheel pixels once, and ignores keys aimed at text fields', () => {
    document.body.innerHTML = '<canvas id="view"></canvas><input id="chat-input" />';
    const canvas = document.getElementById('view') as HTMLElement;
    const input = new BrowserInput(window, canvas);
    const pointer = (type: string, x: number, y: number) =>
      canvas.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, button: 0 }));
    pointer('pointerdown', 10, 10);
    expect(input.isPointerDown(0)).toBe(true);
    pointer('pointermove', 15, 30);
    pointer('pointermove', 25, 20);
    expect(input.pointerDelta()).toEqual({ x: 15, y: 10 });
    expect(input.pointerDelta()).toEqual({ x: 0, y: 0 });
    pointer('pointerup', 25, 20);
    expect(input.isPointerDown(0)).toBe(false);
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 120 }));
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 3, deltaMode: 1 }));
    expect(input.wheelDelta()).toBe(168);
    expect(input.wheelDelta()).toBe(0);

    const chat = document.getElementById('chat-input') as HTMLElement;
    chat.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true }));
    expect(input.isKeyDown('KeyW')).toBe(false);
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
    expect(input.isKeyDown('Space')).toBe(true);
    window.dispatchEvent(new Event('blur'));
    expect(input.isKeyDown('Space')).toBe(false);
    input.dispose();
    document.body.innerHTML = '';
  });
});

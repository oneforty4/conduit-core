import type { SnapshotLimits } from '@conduit/protocol';
import type { DiagnosticOptions } from '@conduit/math';
import type { PresentationProvider } from '@conduit/net-client';
// Browser entry (docs/game.md 4, 5): isomorphic imports only. `@conduit/render` (and with it
// `three`) is reached solely through the dynamic import behind the `canvas` check; the type-only
// imports of it and of `@conduit/lobby-client` are erased.
import {
  AssetLoader,
  AudioBackend,
  BinaryBackend,
  JsonBackend,
  type AssetBackend,
  type AssetLoaderOptions,
  type Manifest,
} from '@conduit/assets';
import {
  ConnectError,
  type ClientState as NetClientState,
  type DisconnectInfo,
  NetClient,
  type NetClock,
  type PredictionOptions,
  type RegionClient,
  ReplicaAt,
  type ReplicaWorld,
  type ReplicatedEventInfo,
} from '@conduit/net-client';
import type {
  InputFrameBase,
  MessageDef,
  RegionSetPayload,
  RejectedPayload,
  SpawnedPayload,
} from '@conduit/protocol';
import type { LobbyClient } from '@conduit/lobby-client';
import { ENTITY_NONE, type EntityId, type InputFrame, Region } from '@conduit/sim';
import { type RegionId, stringCompare } from '@conduit/world';
import type * as RenderModule from '@conduit/render';
import { FrameLoop } from './frame.ts';
import type { Game } from './types.ts';

type Render = typeof RenderModule;
type RenderHost = RenderModule.RenderHost;
type RenderWorld = RenderModule.RenderWorld;

/** Headless frame interval: 60 Hz. */
export const HEADLESS_FRAME_MS = 1000 / 60;

/**
 * Sent in `Hello.sessionToken` when no token is given: the value of `@conduit/auth`'s `DEV_TOKEN`
 * (docs/persist.md 2.4), repeated here because auth is Node-only.
 */
const DEV_TOKEN = 'dev';

/**
 * The connection as a game sees it, from NetClient's states (docs/net.md B.3): `connecting`
 * (Connecting, Handshaking), `connected` (Joined, Loading, Ready), `spawned` (Playing),
 * `reconnecting` (Reconnecting, Resyncing: the connection was lost and is retried with the reconnect
 * token while frames keep running) and `closed` (Disconnected).
 */
export type ClientState =
  'idle' | 'connecting' | 'connected' | 'spawned' | 'reconnecting' | 'closed';

/** What `sampleInput` gets once per client tick. The object is reused; do not keep it. */
export interface InputContext<I> {
  /** `clock.inputTick()` estimate; NetClient stamps the final tick. */
  tick: number;
  /** Actual seconds since the previous successful sample; 0 on the first. */
  dt: number;
  /** Monotonic local time of this sample. */
  sampleTimeMs: number;
  localEntity: EntityId | undefined;
  replica: ReplicaWorld;
  /** The previous sampled frame (a copy), `undefined` for a connection's first sample. */
  previous: I | undefined;
}

export interface FrameContext<I extends InputFrame = InputFrame> {
  /** Fractional; `clock.renderTick()`. */
  renderTick: number;
  /** Seconds since the last frame, clamped to [0, 0.25]. */
  dt: number;
  /**
   * The replica as of `renderTick` (docs/net.md B.5): every component as the view shows it, there
   * from the tick it came to the tick it went, and the entities alive then. `replica.world`
   * (`GameClient.replica`) has the newest of everything.
   */
  replica: ReplicaAt;
  clock: NetClock;
  /** From the own `Spawned`. */
  localEntity: EntityId | undefined;
  /**
   * A copy of the last input frame sent (tick stamped), in one object reused from frame to frame;
   * `undefined` before the connection's first client tick.
   */
  input: Readonly<I> | undefined;
  /**
   * Sorted region ids: `RegionClient.loaded()`/`loading()` (every region it holds, so a region dropped
   * from the set stays in `loaded` during `REGION_RELEASE_GRACE_MS`), the last `RegionSet.active` as
   * `wanted` and its `prefetch` without the active ids. One frozen object, rebuilt only after a
   * `RegionSet`, a `regionLoaded` or a `regionUnloaded`.
   */
  regions: {
    loaded: readonly RegionId[];
    loading: readonly RegionId[];
    wanted: readonly RegionId[];
    prefetch: readonly RegionId[];
  };
  /** Only when a canvas was given. */
  render?: { host: RenderHost; world: RenderWorld };
}

/** Optional fields also accept `undefined`, so options can be passed straight through. */
export interface CreateClientOpts<I extends InputFrame = InputFrame> {
  /** Direct ws URL (createServer mode). Exclusive with `lobby`; one of the two is required. */
  url?: string | undefined;
  /** Dev token or a real SessionToken string, with `url`; default `'dev'` (`DEV_TOKEN`). */
  token?: string | undefined;
  /** Sent in Hello (the devAuth identity); default `''`. */
  displayName?: string | undefined;
  /**
   * Host mode (M5): every `connect()` that opens a connection first calls
   * `lobby.join(sessionId)`, whose `{ token, wsUrl }` it connects with (docs/game.md 4). The caller
   * is logged in and already a member when the session needs an invite code (join it with the code
   * first). A failed join rejects `connect()` with the lobby's `LobbyError`. Exclusive with `url`
   * and `token`.
   */
  lobby?: Pick<LobbyClient, 'join'> | undefined;
  /** The lobby session to join; required with `lobby`. */
  sessionId?: string | undefined;
  /** Present: rendering through `@conduit/render` (dynamically imported). Absent: headless. */
  canvas?: HTMLCanvasElement | undefined;
  /**
   * With `canvas`: how the `RenderHost` is made -- a game-supplied `renderer` (never disposed by
   * the host), `antialias` for the one it would make, `pixelRatioCap`, and `onFrameError` to hear
   * of a frame that threw (which stops it). Default: its own renderer, antialiased, capped at
   * `PIXEL_RATIO_CAP_DEFAULT`.
   */
  render?:
    | Pick<
        RenderModule.RenderHostOptions,
        'renderer' | 'antialias' | 'pixelRatioCap' | 'onFrameError' | 'gpuTiming'
      >
    | undefined;
  /** Registered after the core binders (`RegionBinder`, `TransformBinder`, `ModelBinder`). */
  binders?: RenderModule.Binder<unknown>[] | undefined;
  /**
   * The asset manifest; default `game.assets`. Lets a client whose manifest is only known at
   * runtime (for example fetched from the `/assets/manifest.json` that `conduit-assets build`
   * wrote) keep the shared game definition free of generated files. Neither given: no
   * `AssetLoader`, and models stay placeholders.
   */
  manifest?: Manifest | undefined;
  /**
   * URL prefix the loader resolves asset files against, ending with `/`; default the manifest's
   * `baseUrl` (docs/assets.md 1.1). For assets served from somewhere other than where they were built
   * for, such as a CDN.
   */
  assetBaseUrl?: string | undefined;
  /** `AssetLoader` options: concurrency, unload grace, hash checks, injectable grace timers. */
  assetLoader?: AssetLoaderOptions | undefined;
  /**
   * With `canvas`: options for the render module's `GltfBackend`, such as a `GLTFLoader` set up
   * with the decoders the game's models need (a `KTX2Loader` for KTX2 textures). Default: its own
   * `GLTFLoader`, with none.
   */
  models?: RenderModule.GltfBackendOptions | undefined;
  /** Default `new FollowCamera()` targeting the local entity. */
  camera?: RenderModule.CameraController | undefined;
  /** Passed to `RenderWorld.setInput`; default `NULL_INPUT`. */
  input?: RenderModule.InputSource | undefined;
  /** Called once per client tick inside NetClient's `InputSender`; the result is copied into the frame. */
  diagnostics?: DiagnosticOptions | undefined;
  sampleInput: (ctx: InputContext<I>) => I;
  presentation?: PresentationProvider | undefined;
  snapshotLimits?: Partial<SnapshotLimits> | undefined;
  inputScheduling?: 'hybrid' | 'timer' | 'manual' | undefined;
  maxInputLeadTicks?: number | undefined;
  maxSessionCapacity?: number | undefined;
  extrapolation?: { horizonMs: number; onLimit?: 'hold' | 'reset' } | undefined;
  /** NetClient's `batchSends` (docs/net.md B.6): true, an Ack rides with the next Input. Default false. */
  batchSends?: boolean | undefined;
  onFrame?: ((frame: FrameContext<I>) => void) | undefined;
  /** s2c game message handlers keyed by message name. */
  onMessage?: Record<string, (msg: unknown, frame: FrameContext<I>) => void> | undefined;
  /** `RegionClient`'s `regionLoaded`/`regionUnloaded` (docs/net.md B.8). */
  onRegion?: ((ev: { type: 'loaded' | 'unloaded'; id: RegionId }) => void) | undefined;
  /**
   * Default true: frames are driven by the RenderHost (canvas) or a `HEADLESS_FRAME_MS` interval.
   * false: nothing drives frames; call `tickFrame` (with a canvas the game also renders itself).
   */
  autoFrame?: boolean | undefined;
  /**
   * (M6) The reconciliation stub, handed to the NetClient unchanged (docs/net.md B.10). Off by
   * default; `{ enabled: true }` tracks input acknowledgements (`net.stats().prediction`) and
   * replays nothing, so frames, the replica and rendering are the same either way.
   */
  prediction?: PredictionOptions | undefined;
}

export interface ConnectResult {
  playerId: number;
  localEntity: EntityId;
  /** Estimated server tick when the client started playing. */
  tick: number;
}

export interface GameClientEvents {
  state: ClientState;
  /** Every `Spawned` (any player). */
  spawned: SpawnedPayload;
  rejected: RejectedPayload;
  /**
   * The connection closed: `willReconnect` is true when the client is now `reconnecting` (emitted
   * once per loss) and false when it is `closed` for good, including after the last failed attempt.
   */
  disconnected: DisconnectInfo;
  /** Replicated events at render time (from M2). */
  event: ReplicatedEventInfo;
  authoritativeEvent: ReplicatedEventInfo;
}

export interface GameClient<I extends InputFrame = InputFrame> {
  readonly game: Game<I>;
  /**
   * Resolves once the own entity is spawned and playing; rejects with `ConnectError`. While
   * `reconnecting` it waits for the connection to play again.
   */
  connect(): Promise<ConnectResult>;
  /** Sends Leave, closes; state `'closed'`. */
  disconnect(): void;
  send(type: MessageDef<unknown>, msg: unknown): void;
  /** `net.mirror`. Throws until `connect()` built the NetClient (see `net`). */
  readonly replica: ReplicaWorld;
  /** `net.clock`. Throws until `connect()` built the NetClient (see `net`). */
  readonly clock: NetClock;
  /**
   * Throws before `connect()` built it: at once for a headless client, once the render module has
   * loaded with a canvas (the loader it passes to `RegionClient` needs the module's `GltfBackend`).
   */
  readonly net: NetClient;
  /** `net.regions`. Throws until `connect()` built the NetClient (see `net`). */
  readonly regions: RegionClient;
  /**
   * The `AssetLoader` the first `connect()` builds from `opts.manifest ?? game.assets` (with
   * `GltfBackend` when rendering); `undefined` before that and without a manifest. Its manifest
   * carries `assetBaseUrl` when one was given. Disposed by `dispose()`.
   */
  readonly assets: AssetLoader | undefined;
  readonly state: ClientState;
  /**
   * The own entity from `Spawned`. Kept while reconnecting to the same player; `undefined` after a
   * fresh join (the server had dropped the player) until the new entity spawns, and once closed.
   */
  readonly localEntity: EntityId | undefined;
  on<K extends keyof GameClientEvents>(
    evt: K,
    cb: (payload: GameClientEvents[K]) => void,
  ): () => void;
  /** One frame at `nowMs` (the `performance.now()` time base); for `autoFrame: false`. */
  tickFrame(nowMs: number): void;
  /** Disconnects, stops frames, disposes the render world, the asset loader and the host. */
  dispose(): void;
}

type Listener = (payload: never) => void;

/** Where a connection goes and the token its Hello carries. */
interface ConnectTarget {
  url: string;
  token: string;
}

function netToClientState(s: NetClientState): ClientState {
  switch (s) {
    case 'Disconnected':
      return 'closed';
    case 'Connecting':
    case 'Handshaking':
      return 'connecting';
    case 'Joined':
    case 'Loading':
    case 'Ready':
      return 'connected';
    case 'Playing':
      return 'spawned';
    case 'Reconnecting':
    case 'Resyncing':
      return 'reconnecting';
  }
}

class Client<I extends InputFrame> implements GameClient<I> {
  readonly game: Game<I>;
  private readonly opts: CreateClientOpts<I>;
  private readonly renderModule: Promise<Render> | null;
  /** `opts.manifest ?? game.assets`, with `opts.assetBaseUrl` applied. */
  private readonly manifest: Manifest | undefined;
  private loader: AssetLoader | null = null;
  private readonly listeners = new Map<keyof GameClientEvents, Set<Listener>>();
  private inputCtx: InputContext<I> | null = null;
  private readonly previousFrame: I;
  private readonly sentFrame: I;
  private readonly frames: FrameLoop;
  private netClient: NetClient | null = null;
  private render: { host: RenderHost; world: RenderWorld } | null = null;
  private current: ClientState = 'idle';
  private local: EntityId | undefined = undefined;
  private pending: Promise<ConnectResult> | null = null;
  private lastResult: ConnectResult | null = null;
  private lastFrame: FrameContext<I> | null = null;
  /** The frame object last sampled into (NetClient's ring slot), read back on the next sample. */
  private lastSampled: InputFrameBase | null = null;
  private wanted: readonly RegionId[] = [];
  private prefetch: readonly RegionId[] = [];
  private regionView: FrameContext<I>['regions'] | null = null;
  private attempt = 0;
  private disposed = false;

  constructor(game: Game<I>, opts: CreateClientOpts<I>) {
    if (typeof opts.sampleInput !== 'function') {
      throw new TypeError('createClient: sampleInput is required');
    }
    if (opts.lobby !== undefined) {
      if (typeof opts.sessionId !== 'string' || opts.sessionId === '') {
        throw new TypeError('createClient: lobby needs a sessionId');
      }
      if (opts.url !== undefined || opts.token !== undefined) {
        throw new TypeError('createClient: pass either lobby and sessionId, or url (and token)');
      }
    } else if (opts.sessionId !== undefined) {
      throw new TypeError('createClient: sessionId needs a lobby');
    }
    const baseUrl = opts.assetBaseUrl;
    if (baseUrl !== undefined && !baseUrl.endsWith('/')) {
      throw new TypeError(
        `createClient: assetBaseUrl must end with '/', got ${JSON.stringify(baseUrl)}`,
      );
    }
    this.game = game;
    this.opts = opts;
    const manifest = opts.manifest ?? game.assets;
    this.manifest =
      manifest === undefined || baseUrl === undefined || baseUrl === manifest.baseUrl
        ? manifest
        : { ...manifest, baseUrl };
    this.previousFrame = game.input.create();
    this.sentFrame = game.input.create();
    this.frames = new FrameLoop({
      mode: 'interval',
      intervalMs: HEADLESS_FRAME_MS,
      onFrame: (nowMs, dt) => this.frame(nowMs, dt),
    });
    const canvas = opts.canvas;
    if (canvas !== undefined && canvas !== null) {
      const load = import('@conduit/render');
      load.catch(() => {}); // surfaced by connect(); avoids an unhandled rejection meanwhile
      this.renderModule = load;
    } else {
      this.renderModule = null;
    }
  }

  get state(): ClientState {
    return this.current;
  }

  get localEntity(): EntityId | undefined {
    return this.local;
  }

  get net(): NetClient {
    return this.requireNet('net');
  }

  get replica(): ReplicaWorld {
    return this.requireNet('replica').mirror;
  }

  get clock(): NetClock {
    return this.requireNet('clock').clock;
  }

  get regions(): RegionClient {
    return this.requireNet('regions').regions;
  }

  get assets(): AssetLoader | undefined {
    return this.loader ?? undefined;
  }

  connect(): Promise<ConnectResult> {
    if (this.disposed) return Promise.reject(new Error('GameClient.connect: client is disposed'));
    if (this.pending !== null) return this.pending;
    if (this.current === 'spawned' && this.lastResult !== null) {
      return Promise.resolve(this.lastResult);
    }
    const attempt = ++this.attempt;
    const run = this.run(attempt);
    this.pending = run;
    const clear = (): void => {
      if (this.pending === run) this.pending = null;
    };
    run.then(clear, clear);
    return run;
  }

  disconnect(): void {
    const attempt = ++this.attempt; // a connect() still waiting for the render module gives up
    this.pending = null;
    const net = this.netClient;
    if (net !== null && net.state !== 'Disconnected') net.disconnect();
    if (this.attempt === attempt) this.onClosed();
  }

  send(type: MessageDef<unknown>, msg: unknown): void {
    this.requireNet('send').send(type, msg);
  }

  on<K extends keyof GameClientEvents>(
    evt: K,
    cb: (payload: GameClientEvents[K]) => void,
  ): () => void {
    let set = this.listeners.get(evt);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(evt, set);
    }
    const listener = cb as Listener;
    set.add(listener);
    const owned = set;
    return () => {
      owned.delete(listener);
    };
  }

  tickFrame(nowMs: number): void {
    this.frames.tick(nowMs);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disconnect();
    this.frames.stop();
    const render = this.render;
    this.render = null;
    // The world first: its ModelBinder hands the model handles back. Then the loader disposes every
    // asset still held, while the renderer can still free their GPU resources.
    render?.world.dispose();
    this.loader?.dispose();
    render?.host.dispose();
    this.listeners.clear();
  }

  // -------------------------------------------------------------------------------------------

  private requireNet(what: string): NetClient {
    const net = this.netClient;
    if (net === null) throw new Error(`GameClient.${what}: call connect() first`);
    return net;
  }

  private async run(attempt: number): Promise<ConnectResult> {
    const lobby = this.opts.lobby;
    const url = this.opts.url;
    if (lobby === undefined && (url === undefined || url === '')) {
      throw new Error('createClient: pass url, or lobby and sessionId');
    }
    // A connect() while the NetClient is still connected (say, reconnecting) only waits for Playing.
    const live = this.netClient !== null && this.netClient.state !== 'Disconnected';
    if (!live) this.setState('connecting');
    /** Where a new connection goes; `null` while the NetClient is still connected. */
    let target: ConnectTarget | null = null;
    let r: Render | null = null;
    try {
      if (!live && lobby !== undefined) {
        // Host mode: a lobby join (which starts an idle session) mints this connection's token.
        const joined = await lobby.join(this.opts.sessionId as string);
        target = { url: joined.wsUrl, token: joined.token };
      } else if (!live) {
        target = { url: url as string, token: this.opts.token ?? DEV_TOKEN };
      }
      // Headless without a lobby: no await, so the NetClient below exists as soon as connect()
      // returns.
      r = this.renderModule === null ? null : await this.renderModule;
    } catch (err) {
      if (attempt === this.attempt) this.onClosed();
      throw err;
    }
    if (attempt !== this.attempt || this.disposed) {
      throw new ConnectError('aborted', 'disconnect() called before the connection opened');
    }
    // The loader first: NetClient hands it to RegionClient, which loads each region's asset group.
    this.ensureAssets(r);
    const net = this.ensureNet(target);
    this.lastSampled = null;
    await net.connect(); // Hello -> Welcome: Joined, graph known (docs/net.md B.3)
    if (attempt !== this.attempt || net.state === 'Disconnected') {
      // Closed (or disconnect() called) between Welcome and this continuation.
      throw attempt !== this.attempt
        ? new ConnectError('aborted', 'disconnect() called before the player spawned')
        : new ConnectError('closed', 'connection closed before the player spawned');
    }
    if (r !== null && this.render === null) {
      try {
        this.buildRender(r, net);
      } catch (err) {
        net.disconnect();
        throw err;
      }
    }
    if (this.opts.autoFrame !== false) {
      if (this.render !== null) this.render.host.start();
      else this.frames.start();
    }
    await this.untilPlaying(net, attempt);
    // Set when the NetClient entered Playing (see ensureNet); a resync or fresh join replaces it.
    return (this.lastResult ??= this.playingResult(net));
  }

  private playingResult(net: NetClient): ConnectResult {
    return { playerId: net.playerId, localEntity: net.entity, tick: net.clock.serverTickNow() };
  }

  /** The NetClient, built by the first connect(); `target` is set for a new connection. */
  private ensureNet(target: ConnectTarget | null): NetClient {
    const existing = this.netClient;
    if (existing !== null) {
      // A new connection: with a lobby, the join just minted a fresh token (docs/game.md 4).
      if (target !== null && existing.state === 'Disconnected') {
        existing.setTarget(target.url, target.token);
      }
      return existing;
    }
    if (target === null) throw new Error('GameClient: no connection target');
    const loader = this.loader ?? undefined;
    const net = new NetClient({
      url: target.url,
      game: this.game,
      token: target.token,
      displayName: this.opts.displayName ?? '',
      // RegionClient loads `manifest.regions[id]` per region (docs/net.md B.8); both or neither.
      assets: loader,
      manifest: loader?.manifest,
      prediction: this.opts.prediction, // docs/net.md B.10; undefined is off
      diagnostics: this.opts.diagnostics,
      snapshotLimits: this.opts.snapshotLimits,
      inputScheduling: this.opts.inputScheduling,
      maxInputLeadTicks: this.opts.maxInputLeadTicks,
      maxSessionCapacity: this.opts.maxSessionCapacity,
      extrapolation: this.opts.extrapolation,
      batchSends: this.opts.batchSends,
      sampleInput: (frame, context) => this.sample(net, frame, context),
    });
    this.netClient = net;
    net.on('state', (s, prev) => {
      if (s === 'Playing') {
        this.setLocal(net.entity);
        this.lastResult = this.playingResult(net);
      } else if (s === 'Reconnecting') {
        // The next connection's first sample has no previous frame (docs/game.md 4).
        this.lastSampled = null;
      } else if (s === 'Joined' && prev === 'Reconnecting') {
        // A fresh join: the server no longer knew the reconnect token, so the old entity is gone.
        this.clearLocal();
      }
      if (s === 'Disconnected') this.onClosed();
      else this.setState(netToClientState(s));
    });
    net.on('spawned', (s) => {
      if (s.playerId === net.playerId) this.setLocal(s.entity);
      this.emit('spawned', s);
    });
    net.on('rejected', (r) => this.emit('rejected', r));
    net.on('disconnected', (info) => this.emit('disconnected', info));
    net.on('authoritativeEvent', (event) => this.emit('authoritativeEvent', event));
    net.on('event', (e) => {
      // Due now (NetClient emits at render time), so the world dispatches it in this frame's update.
      this.render?.world.pushEvent(e);
      this.emit('event', e);
    });
    net.on('regionSet', (r: RegionSetPayload) => {
      // As RegionClient reads the set: de-duplicated, sorted, prefetch without the active ids.
      const wanted = [...new Set(r.active)].sort(stringCompare);
      const active = new Set(wanted);
      this.wanted = Object.freeze(wanted);
      this.prefetch = Object.freeze(
        [...new Set(r.prefetch)].filter((id) => !active.has(id)).sort(stringCompare),
      );
      this.regionView = null;
    });
    net.on('message', (m) => {
      const handlers = this.opts.onMessage;
      if (handlers === undefined || !Object.hasOwn(handlers, m.def.name)) return;
      handlers[m.def.name]?.(m.payload, this.lastFrame ?? this.frameContext(0));
    });
    net.regions.on('regionLoaded', (id) => {
      this.regionView = null;
      this.opts.onRegion?.({ type: 'loaded', id });
    });
    net.regions.on('regionUnloaded', (id) => {
      this.regionView = null;
      this.opts.onRegion?.({ type: 'unloaded', id });
    });
    return net;
  }

  /**
   * Builds the loader once (docs/game.md 4): `GltfBackend` only with the render module, so a headless
   * client has no `model` backend (`GltfMetaBackend` arrives in M6) and never loads three.
   */
  private ensureAssets(r: Render | null): void {
    if (this.loader !== null || this.manifest === undefined) return;
    const backends: AssetBackend<unknown>[] = [
      new JsonBackend(),
      new BinaryBackend(),
      new AudioBackend(),
    ];
    if (r !== null) backends.unshift(new r.GltfBackend(this.opts.models));
    this.loader = new AssetLoader(this.manifest, backends, this.opts.assetLoader);
  }

  private buildRender(r: Render, net: NetClient): void {
    const graph = net.graph;
    if (graph === undefined) {
      throw new Error('createClient: game.world(Welcome.worldSeed) failed; cannot render');
    }
    const host = new r.RenderHost({
      ...this.opts.render,
      diagnostics: this.opts.diagnostics,
      canvas: this.opts.canvas as HTMLCanvasElement,
    });
    const world = new r.RenderWorld(host, net.mirror, net.clock, this.loader ?? undefined, graph);
    if (this.opts.presentation !== undefined) world.setPresentationProvider(this.opts.presentation);
    // Core binders first, in docs/render.md 3 order, then the game's. RegionBinder precedes
    // TransformBinder, which adds the region frame offset it computes (docs/render.md 4.2).
    world.registerBinder(new r.RegionBinder(world));
    world.registerBinder(new r.TransformBinder());
    world.registerBinder(new r.ModelBinder(world));
    for (const b of this.opts.binders ?? []) world.registerBinder(b);
    world.setInput(this.opts.input ?? r.NULL_INPUT);
    world.setCamera(this.opts.camera ?? new r.FollowCamera());
    if (this.local !== undefined) world.cameraTarget(this.local);
    // RenderHost drives the frame; host.setWorld is not used, so the clock slews before views
    // sample. `host.timeMs` is the frame's rAF timestamp: reading `performance.now()` here instead
    // would time the frame from after the work above, and that jitter is visible as stutter.
    host.onFrame((dt, h) => this.frames.tick(h.timeMs, dt));
    this.render = { host, world };
  }

  private untilPlaying(net: NetClient, attempt: number): Promise<void> {
    if (net.state === 'Playing') return Promise.resolve();
    return new Promise((resolve, reject) => {
      let closeInfo: DisconnectInfo | null = null;
      const offClose = net.on('disconnected', (info) => {
        closeInfo = info;
      });
      const offState = net.on('state', (s) => {
        if (s !== 'Playing' && s !== 'Disconnected') return;
        offState();
        if (s === 'Playing') {
          offClose();
          resolve();
          return;
        }
        // NetClient emits 'disconnected' (with the close code) right after this state change.
        queueMicrotask(() => {
          offClose();
          const code = closeInfo?.code ?? 1006;
          reject(
            attempt !== this.attempt
              ? new ConnectError('aborted', 'disconnect() called before the player spawned')
              : new ConnectError(
                  'closed',
                  `connection closed before the player spawned (${code})`,
                  { code },
                ),
          );
        });
      });
    });
  }

  private sample(
    net: NetClient,
    frame: InputFrameBase,
    context: { targetTick: number; sampleTimeMs: number; dt: number },
  ): void {
    const schema = this.game.input;
    const ctx = (this.inputCtx ??= {
      tick: 0,
      dt: 0,
      sampleTimeMs: 0,
      localEntity: undefined,
      replica: net.mirror,
      previous: undefined,
    });
    ctx.tick = context.targetTick;
    ctx.dt = context.dt;
    ctx.sampleTimeMs = context.sampleTimeMs;
    ctx.localEntity = this.local;
    ctx.replica = net.mirror;
    if (this.lastSampled === null) {
      ctx.previous = undefined;
    } else {
      schema.copy(this.lastSampled as I, this.previousFrame);
      ctx.previous = this.previousFrame;
    }
    const result = this.opts.sampleInput(ctx);
    schema.copy(result, frame as I);
    this.lastSampled = frame;
  }

  private frame(nowMs: number, dt: number): void {
    const net = this.netClient;
    if (net === null) return;
    if (this.opts.inputScheduling !== 'timer') net.pulseInput();
    net.update(nowMs); // clock slew and ReplicaWorld.gc; must precede the render world
    const render = this.render;
    if (render !== null) {
      if (this.opts.presentation !== undefined) render.world.preparePresentation(nowMs);
      // The floating origin follows the local entity's latest Region (docs/render.md 3.1). Views
      // keep region-local positions, so world positions stay continuous whenever it moves.
      const local = this.local;
      const region =
        local === undefined
          ? undefined
          : this.opts.presentation === undefined
            ? net.mirror.read(local, Region)?.id
            : (render.world.presentationFor(local)?.regionId ?? net.mirror.read(local, Region)?.id);
      if (region !== undefined && region !== render.world.floatingRegion) {
        render.world.setFloatingOrigin(region);
      }
      render.world.update(dt);
    }
    const ctx = this.frameContext(dt);
    this.lastFrame = ctx;
    this.opts.onFrame?.(ctx);
  }

  private frameContext(dt: number): FrameContext<I> {
    const net = this.requireNet('frame');
    let regions = this.regionView;
    if (regions === null) {
      regions = Object.freeze({
        loaded: Object.freeze(net.regions.loaded()),
        loading: Object.freeze(net.regions.loading()),
        wanted: this.wanted,
        prefetch: this.prefetch,
      });
      this.regionView = regions;
    }
    let input: I | undefined;
    if (this.lastSampled !== null) {
      input = this.game.input.copy(this.lastSampled as I, this.sentFrame);
    }
    const renderTick = net.clock.renderTick();
    const ctx: FrameContext<I> = {
      renderTick,
      dt,
      replica: new ReplicaAt(net.mirror, renderTick),
      clock: net.clock,
      localEntity: this.local,
      input,
      regions,
    };
    if (this.render !== null) ctx.render = this.render;
    return ctx;
  }

  private setLocal(entity: EntityId): void {
    if (entity === ENTITY_NONE || entity === this.local) return;
    this.local = entity;
    this.render?.world.cameraTarget(entity);
  }

  /** No own entity: before the first spawn, after a fresh join and once closed. */
  private clearLocal(): void {
    this.local = undefined;
    this.lastResult = null;
    this.render?.world.cameraTarget(null);
  }

  private onClosed(): void {
    this.frames.stop();
    this.clearLocal();
    this.wanted = [];
    this.prefetch = [];
    this.regionView = null;
    this.setState('closed');
  }

  private setState(next: ClientState): void {
    if (this.current === next) return;
    this.current = next;
    this.emit('state', next);
  }

  private emit<K extends keyof GameClientEvents>(evt: K, payload: GameClientEvents[K]): void {
    const set = this.listeners.get(evt);
    if (set === undefined) return;
    for (const listener of [...set]) {
      try {
        (listener as (p: GameClientEvents[K]) => void)(payload);
      } catch (err) {
        console.error(`[conduit/game] '${evt}' listener threw`, err);
      }
    }
  }
}

/**
 * A game client (docs/game.md 4). Construction is cheap and synchronous; the socket, and with a
 * canvas the render module, come in `connect()`. Without a canvas the client is headless and never
 * loads `@conduit/render` or `three`.
 */
export function createClient<I extends InputFrame>(
  game: Game<I>,
  opts: CreateClientOpts<I>,
): GameClient<I> {
  return new Client(game, opts);
}

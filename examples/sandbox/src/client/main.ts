/// <reference types="vite/client" />
// Browser client. Dev mode (`pnpm dev`): connects to the dev server on ws://localhost:8081 (or
// `?server=`) as `?name=`. Host mode (`pnpm dev:host` runs vite with `--mode host`; `?mode=host`
// also selects it): the lobby menu first, then the joined session through the host, whose API and
// sockets vite proxies to port 8080.
import { assertValidManifest, type Manifest } from '@conduit/assets';
import { Name } from '@conduit/game';
import { type CreateClientOpts, createClient, type FrameContext } from '@conduit/game/client';
import { LobbyClient } from '@conduit/lobby-client';
import { ConnectError, describeRejected } from '@conduit/net-client';
import { FollowCamera, OrbitCamera, RegionBoundsHelper, type RenderWorld } from '@conduit/render';
import { Horn, type HornEvent } from '../shared/events.ts';
import { game } from '../shared/game.ts';
import type { SandboxInput } from '../shared/input.ts';
import { Chat, type JoinsMessage } from '../shared/messages.ts';
import { VehicleBinder } from './binders.ts';
import { ChatBox } from './chat.ts';
import { GraceTimers, installDebug } from './debug.ts';
import { Hud } from './hud.ts';
import { BrowserInput, isTextEntry } from './input.ts';
import { type JoinedSession, LobbyMenu } from './menu.ts';
import { RegionGroups } from './regions.ts';
import { dressScene } from './scene.ts';

const DEFAULT_SERVER_URL = 'ws://localhost:8081';
/** Written by `pnpm assets` into `public/assets/` (gitignored), which vite serves at `/assets/`. */
const MANIFEST_URL = '/assets/manifest.json';
/** `Hello.displayName` is at most 32 UTF-8 bytes. */
const MAX_NAME_BYTES = 32;

/** How the client reaches its session: the dev server directly, or a lobby join. */
type Connection = Pick<
  CreateClientOpts<SandboxInput>,
  'url' | 'token' | 'displayName' | 'lobby' | 'sessionId'
>;

const params = new URLSearchParams(window.location.search);

/** `vite --mode host` (`pnpm dev:host`) or `?mode=host`. */
function hostMode(): boolean {
  return import.meta.env.MODE === 'host' || params.get('mode') === 'host';
}

/**
 * `?name=` clipped to 32 UTF-8 bytes. Dev-auth clients with the same name share an account
 * (README), so a tab without one gets a random guest name.
 */
function displayName(): string {
  const requested = params.get('name')?.trim() ?? '';
  const name = requested === '' ? `guest-${Math.floor(Math.random() * 1e6)}` : requested;
  const encoder = new TextEncoder();
  let out = '';
  for (const ch of name) {
    if (encoder.encode(out + ch).byteLength > MAX_NAME_BYTES) break;
    out += ch;
  }
  return out;
}

/**
 * `?server=` when it is a `ws:` or `wss:` URL (another dev server, or a relay in front of this one
 * for reconnect testing), else the dev server on port 8081.
 */
function serverUrl(): string {
  const requested = params.get('server')?.trim() ?? '';
  if (requested === '') return DEFAULT_SERVER_URL;
  try {
    const url = new URL(requested);
    if (url.protocol === 'ws:' || url.protocol === 'wss:') return url.href;
  } catch {
    // not a URL; warned below
  }
  console.warn(`sandbox: ignoring ?server=${requested}: not a ws:// or wss:// URL`);
  return DEFAULT_SERVER_URL;
}

/** An invite link's `?session=<id>&code=<invite code>`, which prefills the menu's join form. */
function inviteFromUrl(): { sessionId: string; code: string } | undefined {
  const sessionId = params.get('session')?.trim() ?? '';
  return sessionId === '' ? undefined : { sessionId, code: params.get('code')?.trim() ?? '' };
}

/**
 * The generated asset manifest, fetched at startup so the shared game definition needs no generated
 * file (docs/game.md 4). Without one (no `pnpm assets` yet) the game runs with placeholder boxes.
 */
async function loadManifest(): Promise<Manifest | undefined> {
  try {
    const response = await fetch(MANIFEST_URL, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const manifest: unknown = await response.json();
    assertValidManifest(manifest);
    return manifest;
  } catch (err) {
    console.warn(
      `sandbox: no asset manifest at ${MANIFEST_URL} (run pnpm assets); models stay boxes`,
      err,
    );
    return undefined;
  }
}

/**
 * `#invite` in host mode: the joined session's id and invite code (`data-session-id`,
 * `data-invite-code`) and a link that opens the menu with them filled in, for the other players.
 */
function showInvite(session: JoinedSession): void {
  const panel = document.getElementById('invite');
  if (panel === null || session.inviteCode === undefined) return;
  const link = new URL(window.location.href);
  link.search = '';
  if (params.get('mode') === 'host') link.searchParams.set('mode', 'host');
  link.searchParams.set('session', session.id);
  link.searchParams.set('code', session.inviteCode);
  const anchor = document.createElement('a');
  anchor.href = link.href;
  anchor.textContent = 'invite link';
  panel.replaceChildren(
    `invite ${session.inviteCode} \u{b7} session ${session.id} \u{b7} `,
    anchor,
  );
  panel.dataset['sessionId'] = session.id;
  panel.dataset['inviteCode'] = session.inviteCode;
  panel.hidden = false;
}

function requiredCanvas(): HTMLCanvasElement {
  const canvas = document.querySelector<HTMLCanvasElement>('#view');
  if (canvas === null) throw new Error('sandbox: <canvas id="view"> is missing from index.html');
  return canvas;
}

const canvas = requiredCanvas();
const manifest = await loadManifest();

/** Builds the HUD, input, chat and render hooks, and connects the game client. */
function play(connection: Connection): void {
  const hud = new Hud(document);
  const input = new BrowserInput(window, canvas);
  const graceTimers = new GraceTimers();
  const vehicles = new VehicleBinder();
  const cameras = { follow: new FollowCamera(), orbit: new OrbitCamera() };
  let camera: keyof typeof cameras = 'follow';
  let world: RenderWorld | undefined;
  const regionGroups = new RegionGroups();
  /** Region outlines while `B` has them on; the floating origin's region is drawn in green. */
  let bounds: RegionBoundsHelper | null = null;
  /** Outline colour of the other regions: the helper's default grey is lost on the dark ground. */
  const BOUNDS_COLOUR = 0x8a93b8;
  const frameHooks: ((frame: FrameContext<SandboxInput>) => void)[] = [
    // Frames run only once connect() built the NetClient, so `client.net` is there.
    (frame) => hud.update(frame, client.net),
  ];

  const chat = new ChatBox(document, (msg) => {
    if (client.state === 'spawned') client.send(Chat, msg);
  });

  const client = createClient(game, {
    ...connection,
    canvas,
    manifest,
    assetLoader: { setTimer: graceTimers.set, clearTimer: graceTimers.clear },
    binders: [vehicles],
    camera: cameras[camera],
    input,
    // Public frame pulse plus absolute timer fallback; render rate does not set input rate.
    inputScheduling: 'hybrid',
    sampleInput: (ctx) => input.sample(ctx),
    onFrame: (frame) => {
      for (const hook of frameHooks) hook(frame);
    },
    onMessage: {
      Chat: (msg) => chat.append(msg),
      Joins: (msg) => hud.setJoins((msg as JoinsMessage).total),
    },
  });

  // The render world exists from the first frame on, before the player spawns (and so before any
  // replicated event or model can arrive).
  frameHooks.push((frame) => {
    if (world !== undefined || frame.render === undefined) return;
    world = frame.render.world;
    dressScene(world);
    vehicles.listen(world);
    world.onEvent(Horn.name, (evt, view, renderWorld) => {
      const { entity } = evt.payload as HornEvent;
      const name = client.replica.read(entity, Name)?.value ?? `entity ${entity}`;
      hud.flash(`horn: ${name}`, evt.tick, renderWorld.renderTick);
      if (view === null) return;
      view.object.scale.setScalar(1.15); // the honking vehicle bumps for 200 ms
      window.setTimeout(() => view.object.scale.setScalar(1), 200);
    });
  });

  // A region group per streamed region (so `B` outlines exactly those), released once unloaded.
  frameHooks.push((frame) => {
    if (world === undefined) return;
    regionGroups.sync(world, frame.regions.loaded, frame.regions.loading);
    bounds?.update();
  });

  // O toggles the follow and orbit cameras (drag to rotate, wheel to zoom while orbiting); B toggles
  // the region outlines.
  window.addEventListener('keydown', (event) => {
    if (event.repeat || isTextEntry(event.target) || world === undefined) return;
    if (event.code === 'KeyO') {
      camera = camera === 'follow' ? 'orbit' : 'follow';
      world.setCamera(cameras[camera]);
      document.body.dataset['camera'] = camera;
    } else if (event.code === 'KeyB') {
      if (bounds === null) {
        bounds = new RegionBoundsHelper(world, { color: BOUNDS_COLOUR });
        bounds.update();
      } else {
        bounds.dispose();
        bounds = null;
      }
      document.body.dataset['bounds'] = bounds === null ? 'off' : 'on';
    }
  });

  // `reconnecting` while a lost connection is retried (the replica keeps drawing meanwhile), then
  // `spawned` again; `closed (<code>)` once the client gives up or the close is final.
  client.on('state', (state) => hud.setState(state));
  client.on('disconnected', (info) => hud.setDisconnected(info));
  // Final: the client never reconnects after a rejection (a changed schema needs a reload).
  client.on('rejected', (rejected) => hud.setFinal(describeRejected(rejected)));

  const connecting = client.connect();
  frameHooks.push(installDebug(client, connecting, graceTimers));
  connecting.catch((err: unknown) => {
    if (err instanceof ConnectError && err.kind === 'rejected') return; // shown by 'rejected'
    const message = err instanceof Error ? err.message : String(err);
    hud.setFinal(`connect failed: ${message}`);
    console.warn('sandbox: connect failed', err);
  });
}

if (hostMode()) {
  // Same origin: vite proxies the lobby routes and the game sockets to the host (vite.config.ts).
  const lobby = new LobbyClient({ baseUrl: '' });
  const menu = new LobbyMenu(document, {
    lobby,
    gameId: game.id,
    invite: inviteFromUrl(),
    onJoin: (session) => {
      showInvite(session);
      play({ lobby, sessionId: session.id });
    },
  });
  void menu.start();
} else {
  play({ url: serverUrl(), token: 'dev', displayName: displayName() });
}

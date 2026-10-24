# sandbox

The reference game for conduit-core (PLAN.md "Sandbox content spec"): a 16 x 16 grid of 256 m cells,
one coloured kinematic vehicle per player, and crates plus a wandering AI in every cell. It is the
fixture for `packages/game/test/headless.test.ts` and the browser checks.

Use Node 24 and pnpm 11.21.0; run `pnpm install --frozen-lockfile` at the repository root first.
For your own game, follow the [separate game repository setup](../../docs/consuming.md#5-consuming-from-a-game-repo).

```
src/shared/   game definition: components, input, Chat message, Horn event, systems (pure sim code), defineGame
src/server/   RegionLoader, hooks (incl. chat), the game module (game + sessionFactory), the dev server
src/client/   browser client: lobby menu (host mode), input, VehicleBinder, chat box, HUD, region groups, scene lights and ground, window.__conduit
assets/       Blender sources and their glTF exports (crate, vehicle), input of `pnpm assets`
scripts/      make-models.py (rebuilds assets/ in Blender), export-world.ts (rebuilds world.json)
test/         game, systems, loader and jsdom client and menu unit tests (pnpm --filter @conduit-examples/sandbox test)
e2e/          Playwright specs (pnpm e2e) and their helpers
```

## Run modes

| Command (repo root) | What runs | Auth |
| --- | --- | --- |
| `pnpm assets` | `conduit-assets build` of `assets/` into `public/assets/` (gitignored) with `world.json`'s region lists, then `conduit-assets check` | none |
| `pnpm dev` | `pnpm assets`, then vite on http://localhost:5173 and `tsx watch src/server/main.ts` (`createServer` on ws://127.0.0.1:8081; state in memory unless `SANDBOX_DB` is set, see below) | `devAuth: true`, token `dev` |
| `pnpm dev:host` | `pnpm assets`, then vite on http://localhost:5173 in host mode (the lobby menu; the host's routes proxied to it) and the `conduit-host` CLI with `src/server/game.ts` on 8080 (see Host mode below) | lobby-minted tokens, `HOST_SECRET` |
| `pnpm e2e` | Playwright, Chromium by default: render-memory and debugger-suspension checks against `pnpm dev`, plus two-account lobby/movement smoke against `pnpm dev:host` on ports 5174 and 8090; `playwright.config.ts` starts both servers unless already running (always fresh under `CI`) | as above |

With `pnpm dev`, open two tabs with different names, for example
http://localhost:5173/?name=alice and http://localhost:5173/?name=bob. Drive with `W`/`S`
(throttle) and `A`/`D` (steer); `Space` sounds the horn, which flashes the HUD in every tab. `O`
switches between the follow camera and an orbit camera (drag to rotate, wheel to zoom; the models
switch to lower levels of detail as you zoom out). `Enter` opens the chat box; `Enter` sends,
`Escape` leaves it. The HUD shows the connection state, render tick, RTT, visible entities,
the streamed regions (their counts, then the loaded, loading and releasing ids), the bytes per second
received and sent, and the session's join counter. Both players spawn
in `cell/8_8` of the 16 x 16 grid and can drive anywhere: a client holds the 3 x 3 cells around its
vehicle plus the ring of 16 around those (prefetched), and a region that falls out of that set is
listed as releasing for 5 s before it unloads. `B` outlines the held regions (the one you are in is
green).

## Host mode

`HOST_SECRET=<at least 32 bytes> pnpm dev:host` runs the production path: the lobby (accounts, sessions,
invite codes), the WebSocket gateway and one worker thread per running session (docs/host.md). A secret can
be made with `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`. Accounts,
sessions and every session's world live in `DB_PATH` (default `./conduit.sqlite` in this package, gitignored).
Vite runs with `--mode host` and forwards `/auth`, `/me`, `/games`, `/sessions`, `/friends`, `/lobby`,
`/session` and `/healthz` (WebSocket upgrades included) to the host, so everything stays on
http://localhost:5173. `PORT` moves the host (and the proxy follows); `SANDBOX_VITE_PORT` moves vite.
`?mode=host` also selects host mode on a plain `vite`.

Open http://localhost:5173 in two browsers (or a normal and a private window: each needs its own login
cookie). Register an account in each; registering logs in. In the first, create a session (private sessions
are joined with their invite code) and press Play. The session list, and the panel at the top right once
playing, show its session id and invite code, plus an invite link that opens the menu with both filled in.
In the second, enter them under "Join by invite code". Both cars now drive in the same session, and
http://localhost:5173/healthz lists it as running with 2 clients. A session nobody is connected to stops
after 5 minutes (`IDLE_TIMEOUT_MS`) and starts again, from its saved state, on the next join.

## Persistence and reconnects

`SANDBOX_DB=./sandbox.sqlite pnpm dev` keeps the world in a SQLite file (resolved against
`examples/sandbox`; the server prints the absolute path when it starts, and `*.sqlite*` files are
gitignored). A region nobody is near is saved 10 s after the last vehicle left its 3 x 3 neighbourhood
and restored from the file when someone comes back: its crates are where they were and its wanderer
carries on from where it stopped. Every active region and the session state (the join counter shown
in the HUD) are also saved every 60 s and when the server stops: `Ctrl-C` (SIGINT) or SIGTERM calls
`server.close()`, which prints `sandbox server closed; session saved to <file>`. Starting again on the
same file continues the world and the counter. Without `SANDBOX_DB` the state lives in memory and
every start is a fresh world. (On `Ctrl-C` the dev runner stops tsx once vite has exited, and tsx then
kills the server if it is still running; the save happens before that. Vite also reloads open tabs
when the dev server comes back, and a reloaded tab joins as a new player while its old vehicle waits
out the reconnect grace, so the counter moves on by one per tab.)

When a tab loses its connection, `state` shows `reconnecting` while it retries (after 0.5, 1, 2, 4
and 8 s). Within the reconnect grace (120 s; `SANDBOX_RECONNECT_GRACE_MS=<ms>` changes it) it
continues as the same player with the same vehicle and the other tabs see nothing but a pause. After
the grace the server removes the vehicle, and a later attempt joins as a new player; once every
attempt failed the state reads `closed (<code>)`. DevTools' offline mode may not close a WebSocket that
is already open, so to try this, point a tab at a relay you can cut with `?server=`, for example
http://localhost:5173/?name=alice&server=ws://127.0.0.1:18081 with a TCP relay from port 18081 to 8081.

After changing a replicated component, input or message schema, restart the server and reload every
tab: a tab built from the old schema is refused with `Rejected: SchemaMismatch — please refresh`
and does not retry.

Core now uses wire version 4; upgrade client and server together. Sessions publish coherent
application-save generations. Use `openApplicationSave` when inspecting current stored state;
raw legacy `region`/`session` keys may contain preserved originals. See
[generation saves and migrations](../../docs/generation-saves.md). Application saves are separate
from exact offline replay checkpoints.

The client uses public hybrid input scheduling. The sandbox's vehicle rules remain consumer code;
generic prediction, selective replication budgets, and memory policies are opt-in framework APIs.
Eight remains the public session limit. The [validation guide](../../docs/implementation-harness.md)
describes the checks and outstanding performance qualifications.

## Browser verification

Install the matching browser builds from the repository root, then run engines separately:

```sh
pnpm --filter @conduit-examples/sandbox exec playwright install chromium firefox webkit
pnpm e2e
CONDUIT_BROWSER=firefox pnpm e2e
CONDUIT_BROWSER=webkit pnpm e2e
```

Each engine runs the resource-ownership and two-account host smoke tests. Chromium additionally
pauses JavaScript through the debugger for 2.5 seconds and verifies input/snapshot recovery.
That case proves forced main-thread suspension recovery, not physical hidden-tab throttling.
Set `CI=1` to require fresh test servers; ports 5173, 5174, 8081 and 8090 must be available.
The host test uses a separate temporary SQLite database. See the
[scenario guide](../../docs/implementation-harness.md) for timing evidence and limits.

## Dev auth identities

`devAuth` accepts any token and derives the account from the display name
(`accountId = 'dev:' + name.toLowerCase()`, docs/game.md 2). Two clients with the same `?name=`
(`Alice` and `alice` included) are therefore the same account, and the session may treat the second
as the first one reconnecting (docs/net.md A.6). Give every tab a unique `?name=`; a tab opened
without one gets a random `guest-NNNNNN` name. Automated tests use distinct names for the same
reason.

## Assets

The client fetches `/assets/manifest.json`, which `pnpm assets` (and so `pnpm dev`) generates; without
it the game still runs, with magenta placeholder boxes and a console warning. The models are built from
scratch by `scripts/make-models.py` in Blender 5.2 (see its header for the command) following
docs/assets.md section 5; `conduit-assets.json` puts both in the `core` group. `world.json` is
`game.graphJson()`: after changing the world in `src/shared/game.ts`, run
`pnpm --filter @conduit-examples/sandbox world` and commit the result (`test/game.test.ts` checks it).

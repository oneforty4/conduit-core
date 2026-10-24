# conduit-core

A TypeScript framework for server-authoritative multiplayer games. Core provides fixed-tick
simulation, schemas and networking, streamed worlds, persistence, asset ownership, and optional
Three.js presentation. Game rules, controls, movement, collisions, and prediction models belong
to the game.

## Start here

- [Run the sandbox](examples/sandbox/README.md) to try the complete client/server and hosted lobby.
- [Use core in a game repository](docs/consuming.md#5-consuming-from-a-game-repo) for workspace,
  TypeScript, Vite, host bundling, CI, and upgrade instructions.
- [Define a game](docs/game.md) using the public `@conduit/game` entrypoints.
- [Validation scenarios and limits](docs/implementation-harness.md) describe reproducible checks,
  measurement scope, and failed performance qualifications.

## Run this repository

Use Node 24 (the CI target) and pnpm 11.21.0. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Open <http://localhost:5173/?name=alice> and a second tab with `?name=bob`. The command builds
assets and starts Vite plus the development game server. Use W/S to drive, A/D to steer, Space
for the horn, and Enter for chat. [Sandbox host mode](examples/sandbox/README.md#host-mode)
adds accounts, a lobby, session workers, and SQLite storage.

## Use it in your game

The recommended current setup is a **pinned Git submodule plus one pnpm workspace**. Keep
your game in its own repository and place core at `vendor/conduit-core`. Git records the core
commit; pnpm links its packages into your game. Core packages are currently private,
version `0.0.0`, and export `.ts` sources with `workspace:*` dependencies. This repository
does not yet provide a versioned registry-package release workflow.

```text
my-game/
  vendor/conduit-core/     # submodule pinned to a reviewed commit
  apps/client/            # browser app
  apps/host/              # server and worker bundle
  shared/                 # schemas, systems, GameDef, session factory
  pnpm-workspace.yaml
  pnpm-lock.yaml
```

The game root's `pnpm-workspace.yaml` includes:

```yaml
packages:
  - 'vendor/conduit-core/packages/*'
  - 'apps/*'
  - 'shared'

allowBuilds:
  esbuild: true
```

Declare `"@conduit/game": "workspace:*"` in the game packages that import it, and
`"@conduit/tooling": "workspace:*"` where you use its presets. Run installs from the game
root and commit the game's lockfile with the submodule pointer. Clone with
`git clone --recurse-submodules <game-repository-url>`. Upgrade by selecting and testing an
explicit core commit, then reviewing the pointer and lockfile changes together.

Follow the [complete setup and upgrade recipe](docs/consuming.md#5-consuming-from-a-game-repo)
before installing. It includes the app manifests, shared compiler settings, renderer dependency
pinning, and host worker build. A core revision must be committed and available to your team/CI
before another repository can pin it; local uncommitted changes are not part of a submodule pin.

| Import | Purpose |
| --- | --- |
| `@conduit/game` | Shared definitions, schemas, simulation, and world APIs |
| `@conduit/game/client` | Browser or headless clients; optional rendering and prediction |
| `@conduit/game/server` | Standalone sessions, persistence, and offline replay |
| `@conduit/game/host` | Lobby, gateway, and per-session workers |

Keep Node-only imports out of browser/shared modules. Use a sibling checkout with local links
for temporary core/game development when useful; the consumer guide explains its dependency
and Three.js duplication caveats.

## Current contracts and limits

- **Wire version 4:** coordinate client/server upgrades. Game simulation compatibility,
  state-schema identity, application saves, and exact replay have separate contracts.
- **Eight players remain the default and public limit.** The wire codec ceiling is sixteen;
  sixteen-player admission did not pass qualification.
- Prediction, selective replication budgets, diagnostics, and asset memory policies are
  optional. Quantized masks save bytes in measured moving workloads but increase CPU cost;
  constrained delivery trades state freshness for bandwidth.
- Functional verification passed 1,945 tests and seven browser tests on 2026-10-24, with one
  existing opt-in long timer test skipped. Performance qualification remains incomplete:
  finite-validation overhead and eight-player RSS/checkpoint limits exceeded the selected
  tolerances. See the [qualification results](docs/implementation-harness.md) before choosing workload budgets.

## Verification

```sh
pnpm typecheck
pnpm lint
pnpm format
pnpm test
pnpm check:three
pnpm --filter @conduit-examples/sandbox exec playwright install chromium firefox webkit
pnpm e2e
CONDUIT_BROWSER=firefox pnpm e2e
CONDUIT_BROWSER=webkit pnpm e2e
```

Chromium includes a forced JavaScript suspension recovery test; this does not qualify physical
hidden-tab throttling. CI runs the three browser engines separately and offers the optional
600-second timer check through `workflow_dispatch` with `extended_checks`. See
[the workflow](.github/workflows/ci.yml) and [scenario documentation](docs/implementation-harness.md).

## Documentation

| Area | Guide |
| --- | --- |
| Integration and production bundles | [Consuming core](docs/consuming.md), [game facade](docs/game.md) |
| Simulation and ownership | [ECS, faults, checkpoints, replay](docs/sim.md) |
| Network and compatibility | [Networking](docs/net.md), [protocol](docs/protocol.md), [bounded replication](docs/bounded-replication.md) |
| Worlds and persistence | [Worlds](docs/world.md), [storage](docs/persist.md), [save generations and migrations](docs/generation-saves.md) |
| Rendering and resources | [Rendering](docs/render.md), [assets and memory policies](docs/assets.md) |
| Hosting and validation | [Host](docs/host.md), [scenario harness](docs/implementation-harness.md) |

[CONCEPT.md](CONCEPT.md) describes the architecture and design principles. The maintained guides
above document supported behavior and qualification limits.

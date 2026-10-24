# @conduit/tooling, repo tooling, and consuming core from a game repo

Covers the conduit-core root files, the `@conduit/tooling` package (tsconfig base, eslint factory, prettier,
vite/vitest presets, `conduit-assets` bin), the per-package `package.json` template, why there is no library build
and how production bundles are produced, the game-repo layout for submodule consumption, pitfalls, and this
repo's CI including the consume job. The `conduit-assets` CLI logic itself is docs/assets.md; the `three`
quarantine it enforces is docs/render.md.

## Recommended integration

For the current source-distributed packages, use **a Git submodule pinned to a reviewed commit,
included in the game's pnpm workspace**. Git records the core revision; `workspace:*` connects the
packages. The game's root install and lockfile cover both game and core dependencies. The
[setup recipe below](#5-consuming-from-a-game-repo) includes initial checkout, CI, and deliberate upgrades.

Core packages are `private: true`, version `0.0.0`, export TypeScript sources, and depend on other
core packages through `workspace:*`. Installing the repository root as a single Git/npm dependency
does not reproduce this multi-package layout. Versioned registry packages would be an alternative
after a publishing/versioning workflow is added; that workflow is not currently provided here.

Use a [sibling checkout](#sibling-checkout-alternative-link) for temporary development across core
and a game. Return to the committed submodule/workspace arrangement for reproducible game CI.
Commit/push the selected core revision before recording it in a game repository; an uncommitted
core worktree cannot be pinned. References: [Git submodules](https://git-scm.com/book/en/v2/Git-Tools-Submodules)
and [pnpm workspace packages](https://pnpm.io/workspaces#workspace-protocol-workspace).

Use Node 24, the CI target, and the pinned pnpm version below for new game workspaces.
Manifest versions/ranges used throughout (the lockfile records exact resolved versions):

| Tool | Version |
| --- | --- |
| node | `>=22` (`24.x` in CI; Node `>=22.18` is required to load `.ts` presets without `tsx`, see pitfalls) |
| pnpm | `11.21.0` (`packageManager`) |
| typescript | `^5.6.0` |
| vitest | `^3.1.0` |
| vite | `^6.1.0` |
| eslint | `^9.15.0`, `@eslint/js` `^9.15.0`, `typescript-eslint` `^8.15.0` |
| prettier | `^3.3.0` |
| tsx | `^4.19.0` |
| esbuild | `^0.24.0` |
| @playwright/test | `^1.49.0` |
| jsdom | `^25.0.0` |
| @types/node | `^22.10.0` |
| three / @types/three | exact pin chosen by the app; reference pin `0.170.0` |

## 1. Repo root files

### `package.json`

```json
{
  "name": "conduit-core",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@11.21.0",
  "engines": { "node": ">=22" },
  "scripts": {
    "typecheck": "pnpm -r --workspace-concurrency=4 run typecheck",
    "lint": "eslint . --max-warnings 0",
    "format": "prettier --check .",
    "format:write": "prettier --write .",
    "test": "vitest run",
    "dev": "pnpm --filter @conduit-examples/sandbox dev",
    "dev:host": "pnpm --filter @conduit-examples/sandbox dev:host",
    "e2e": "pnpm --filter @conduit-examples/sandbox e2e",
    "assets": "pnpm --filter @conduit-examples/sandbox assets",
    "check:three": "pnpm why -r three --json | node scripts/assert-single-three.mjs"
  },
  "devDependencies": {
    "@conduit/tooling": "workspace:*",
    "@eslint/js": "^9.15.0",
    "eslint": "^9.15.0",
    "prettier": "^3.3.0",
    "typescript": "^5.6.0",
    "typescript-eslint": "^8.15.0",
    "vitest": "^3.1.0"
  }
}
```

`pnpm assets` builds and checks the sandbox's assets (M2, the PLAN.md M2 gate): the sandbox's own `assets` script
runs `conduit-assets build assets public/assets --graph world.json --clean && conduit-assets check
public/assets/manifest.json` in `examples/sandbox`, which is `conduit-assets build examples/sandbox/assets
examples/sandbox/public/assets --graph examples/sandbox/world.json` (plus `--clean`) and a `check` of the written
manifest, with groups from `examples/sandbox/conduit-assets.json`. Other builds call the bin directly
(`pnpm exec conduit-assets ...`, section 2).

`scripts/assert-single-three.mjs` (root; used by `check:three` and CI):

```js
// Reads `pnpm why -r three --json` from stdin; exits 1 unless exactly one `three` version is resolved.
let src = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) src += chunk;
const versions = new Set();
const walk = (n) => {
  if (!n || typeof n !== 'object') return;
  if (Array.isArray(n)) return n.forEach(walk);
  // pnpm 11: one top-level entry per resolved copy, `{ name, version, dependents }`.
  if (n.name === 'three' && typeof n.version === 'string' && Array.isArray(n.dependents))
    versions.add(n.version);
  // pnpm 9: importer trees whose dependency nodes carry `from`.
  if (n.from === 'three' && typeof n.version === 'string') versions.add(n.version);
  for (const k of ['dependencies', 'devDependencies', 'peerDependencies'])
    if (n[k]) walk(Object.values(n[k]));
};
walk(JSON.parse(src || '[]'));
if (versions.size !== 1) {
  console.error('three versions resolved:', [...versions]);
  process.exit(1);
}
console.log('three resolves to a single version:', [...versions][0]);
```

pnpm 11 prints `why --json` as a reverse tree (one entry per resolved copy); the pnpm 9 shape is still accepted for
game repos on older pnpm. While nothing depends on `three` (M0) the script finds zero versions and exits 1.

### `pnpm-workspace.yaml`

```yaml
packages:
  - 'packages/*'
  - 'examples/*'

allowBuilds:
  esbuild: true
```

pnpm 11 blocks dependency build scripts unless allowed; esbuild (under vite, vitest and tsx) is currently the only
dependency with one.

### `.npmrc`

```ini
auto-install-peers=true
strict-peer-dependencies=false
```

### `tsconfig.json`

```json
{
  "extends": "./packages/tooling/tsconfig.base.json",
  "compilerOptions": { "types": ["node"] },
  "include": ["vitest.workspace.ts"]
}
```

Root typecheck is delegated to each package (`pnpm -r run typecheck`); this file only covers root-level config.

### `vitest.workspace.ts`

```ts
export default ['packages/*', 'examples/*'];
```

### `eslint.config.js`

```js
import { conduitEslint } from './packages/tooling/eslint.config.js';

export default conduitEslint({
  simGlobs: ['packages/math/src/**', 'packages/protocol/src/**', 'packages/sim/src/**', 'packages/world/src/**'],
  // The sandbox's scene setup stands in for a game client app's own three code (section 5).
  renderGlobs: ['packages/render/**', 'examples/sandbox/src/client/scene.ts'],
  browserGlobs: [
    'packages/render/src/**',
    'packages/net-client/src/**',
    'packages/lobby-client/src/**',
    'packages/assets/src/**',
    'packages/game/src/index.ts',
    'packages/game/src/client.ts',
    'examples/sandbox/src/client/**',
  ],
  browserIgnores: ['packages/assets/src/node.ts', 'packages/assets/src/build.ts', 'packages/assets/src/check.ts', 'packages/assets/src/cli.ts'],
});
```

Only `@conduit/render` imports `three` among core packages. Games own lights, ground and other scene dressing
(CONCEPT.md principle 6), and a game's client app depends on `three` for them (section 5), listing its scene code in
its own `renderGlobs`. The sandbox does the same for exactly one file, `examples/sandbox/src/client/scene.ts` (lights
and ground; glTF materials render black without light, M2); everything else in the sandbox stays `three`-free and
handles materials structurally.

### `prettier.config.js`

```js
export { default } from './packages/tooling/prettier.config.js';
```

### `.prettierignore`

```
# Prettier also reads .gitignore (node_modules, dist, coverage, ...).
pnpm-lock.yaml
# Docs use wide tables and hand-wrapped prose that prettier would rewrite.
*.md
# Generated by `pnpm --filter @conduit-examples/sandbox world` (JSON.stringify output, committed).
examples/sandbox/world.json
```

### `.gitignore`

```
node_modules/
dist/
coverage/
*.tsbuildinfo
.DS_Store
.env
*.sqlite
*.sqlite-wal
*.sqlite-shm
playwright-report/
test-results/
examples/sandbox/public/assets/
```

### `.gitmodules` guidance

conduit-core itself has no submodules and no `.gitmodules`. A game repo adds core with:

```
git submodule add -b main git@github.com:<org>/conduit-core.git vendor/conduit-core
git config -f .gitmodules submodule.vendor/conduit-core.shallow false
git config submodule.recurse true
```

Resulting `.gitmodules` in the game repo:

```ini
[submodule "vendor/conduit-core"]
	path = vendor/conduit-core
	url = git@github.com:<org>/conduit-core.git
	branch = main
	shallow = false
```

`shallow = false` because the consume workflow and `git describe` need history. The pinned commit is whatever the
game repo's tree records; `branch` only affects `git submodule update --remote`.

## 2. `@conduit/tooling`

Layout:

```
packages/tooling/
  package.json
  tsconfig.base.json
  eslint.config.js
  prettier.config.js
  vitest.preset.ts
  vite.preset.ts
  bin/conduit-assets.mjs
  src/index.ts            re-exports conduitVitest, conduitVite (types for consumers)
  test/eslint-rules.test.ts
  test/tsconfig.test.ts
  test/presets.test.ts
  test/bin.test.ts
```

### `package.json`

```json
{
  "name": "@conduit/tooling",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "sideEffects": false,
  "bin": { "conduit-assets": "./bin/conduit-assets.mjs" },
  "exports": {
    ".": { "types": "./src/index.ts", "default": "./src/index.ts" },
    "./tsconfig.base.json": "./tsconfig.base.json",
    "./eslint": "./eslint.config.js",
    "./prettier": "./prettier.config.js",
    "./vitest": { "types": "./vitest.preset.ts", "default": "./vitest.preset.ts" },
    "./vite": { "types": "./vite.preset.ts", "default": "./vite.preset.ts" }
  },
  "scripts": { "typecheck": "tsc -p tsconfig.json", "test": "vitest run" },
  "dependencies": {
    "@conduit/assets": "workspace:*",
    "tsx": "^4.19.0"
  },
  "peerDependencies": {
    "@eslint/js": "^9.15.0",
    "eslint": "^9.15.0",
    "typescript-eslint": "^8.15.0",
    "vite": "^6.1.0",
    "vitest": "^3.1.0"
  },
  "peerDependenciesMeta": {
    "@eslint/js": { "optional": true }, "eslint": { "optional": true }, "typescript-eslint": { "optional": true },
    "vite": { "optional": true }, "vitest": { "optional": true }
  },
  "devDependencies": {
    "@eslint/js": "^9.15.0", "@types/node": "^22.10.0", "eslint": "^9.15.0", "typescript": "^5.6.0",
    "typescript-eslint": "^8.15.0", "vite": "^6.1.0", "vitest": "^3.1.0"
  }
}
```

"Tooling has no runtime dependencies" (CONCEPT.md) refers to game runtime; `@conduit/assets` and `tsx` are needed
only by the `conduit-assets` bin, which is a dev tool. Until M2 (when `@conduit/assets` and the bin land) the
manifest omits `bin` and the `@conduit/assets` dependency.

### `tsconfig.base.json`

```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "types": [],
    "strict": true,
    "exactOptionalPropertyTypes": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "useUnknownInCatchVariables": true,
    "noEmit": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

`allowImportingTsExtensions: true` (legal because `noEmit` is set) is required: files that Node loads natively
(`vitest.preset.ts`, `vite.preset.ts`, `src/cli.ts` in host) must use explicit `.ts` specifiers for relative imports,
since Node's type stripping performs no extension resolution.

Per-package `tsconfig.json` shapes (relative `extends`, never package-name `extends`, so it works identically inside
a submodule):

Isomorphic packages (`math`, `protocol`, `sim`, `world`, `assets`, `net-client`, `lobby-client`, `game`):

```json
{ "extends": "../tooling/tsconfig.base.json", "include": ["src", "test"] }
```

Node packages (`persist`, `auth`, `net-server`, `lobby`, `host`) and isomorphic packages whose tests need Node:

```json
{ "extends": "../tooling/tsconfig.base.json", "compilerOptions": { "types": ["node"] }, "include": ["src", "test"] }
```

Browser packages (`render`; the sandbox client uses the same options with its own relative `extends` path):

```json
{ "extends": "../tooling/tsconfig.base.json", "compilerOptions": { "lib": ["ES2022", "DOM", "DOM.Iterable"], "types": ["node"] }, "include": ["src", "test"] }
```

`types: ["node"]` in browser packages exists only for vitest/jsdom test files; source files must not use Node
APIs (the eslint browser rule catches `node:*` imports; globals like `process` are caught by `no-restricted-globals`
in the browser block below). `@conduit/assets` and `@conduit/game` (iso packages containing Node subpaths) use the
node shape.

### `eslint.config.js`

```js
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const THREE_MESSAGE = 'Only @conduit/render may import three (CONCEPT.md principle 1).';
const NODE_MESSAGE = 'Browser packages may not import Node built-ins or ws.';
const PURITY = 'Sim code is pure: no wall clock, Math.random or timers (CONCEPT.md principle 3). Use ctx.rng / ctx.tick.';
const TEST_FILES = ['**/test/**', '**/*.test.ts', '**/e2e/**'];
const SCRIPT_FILES = ['scripts/**', '**/bin/**'];
// Node's ESM runtime globals, inlined (the `globals` package is not a dependency). Only plain JS
// files need them: typescript-eslint turns `no-undef` off for TypeScript.
const NODE_GLOBALS = Object.fromEntries(
  `AbortController AbortSignal Blob BroadcastChannel Buffer CustomEvent DOMException Event
  EventTarget File FormData Headers MessageChannel MessageEvent MessagePort ReadableStream Request
  Response TextDecoder TextEncoder TransformStream URL URLSearchParams WebAssembly WebSocket
  WritableStream clearImmediate clearInterval clearTimeout console crypto fetch global navigator
  performance process queueMicrotask setImmediate setInterval setTimeout structuredClone`
    .split(/\s+/)
    .map((name) => [name, 'readonly']),
);

/**
 * @param {{
 *   simGlobs?: string[]; renderGlobs?: string[]; browserGlobs?: string[]; browserIgnores?: string[];
 *   ignores?: string[]; extra?: import('eslint').Linter.Config[];
 * }} opts
 */
export function conduitEslint({
  simGlobs = [],
  renderGlobs = [],
  browserGlobs = [],
  browserIgnores = [],
  ignores = [],
  extra = [],
} = {}) {
  const banThree = {
    'no-restricted-imports': ['error', { patterns: [{ group: ['three', 'three/*'], message: THREE_MESSAGE }] }],
  };
  const banNodeAndThree = {
    'no-restricted-imports': [
      'error',
      {
        paths: [{ name: 'ws', message: NODE_MESSAGE }],
        patterns: [
          { group: ['three', 'three/*'], message: THREE_MESSAGE },
          { group: ['node:*', 'fs', 'path', 'crypto', 'worker_threads', 'child_process', 'http', 'https', 'net', 'os', 'url', 'util', 'stream', 'events'], message: NODE_MESSAGE },
        ],
      },
    ],
    'no-restricted-globals': ['error', { name: 'process', message: NODE_MESSAGE }, { name: 'Buffer', message: NODE_MESSAGE }],
  };
  const renderOnlyBanNode = {
    'no-restricted-imports': [
      'error',
      {
        paths: [{ name: 'ws', message: NODE_MESSAGE }],
        patterns: [{ group: ['node:*'], message: NODE_MESSAGE }],
      },
    ],
  };
  const purity = {
    'no-restricted-globals': [
      'error',
      { name: 'Date', message: PURITY },
      { name: 'performance', message: PURITY },
      { name: 'setTimeout', message: PURITY },
      { name: 'setInterval', message: PURITY },
      { name: 'setImmediate', message: PURITY },
      { name: 'requestAnimationFrame', message: PURITY },
      { name: 'queueMicrotask', message: PURITY },
    ],
    'no-restricted-properties': [
      'error',
      { object: 'Math', property: 'random', message: PURITY },
      { object: 'Date', property: 'now', message: PURITY },
      { object: 'performance', property: 'now', message: PURITY },
      { object: 'crypto', property: 'getRandomValues', message: PURITY },
      { object: 'crypto', property: 'randomUUID', message: PURITY },
    ],
    'no-restricted-syntax': [
      'error',
      { selector: "CallExpression[callee.name='setTimeout']", message: PURITY },
      { selector: "CallExpression[callee.name='setInterval']", message: PURITY },
      { selector: "CallExpression[callee.object.name='globalThis'][callee.property.name=/^(setTimeout|setInterval|setImmediate)$/]", message: PURITY },
      { selector: "NewExpression[callee.name='Date']", message: PURITY },
      { selector: "CallExpression[callee.property.name='sort'][arguments.length=0]", message: 'Sim code sorts with an explicit comparator (docs/sim.md 2.12 rule 4).' },
    ],
  };

  return tseslint.config(
    { ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', '**/playwright-report/**', '**/test-results/**', ...ignores] },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
      files: ['**/*.ts', '**/*.mts', '**/*.js', '**/*.mjs'],
      rules: {
        ...banThree,
        '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports', fixStyle: 'inline-type-imports' }],
        '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
        '@typescript-eslint/no-explicit-any': 'error',
        'no-console': ['warn', { allow: ['warn', 'error'] }],
      },
    },
    { files: ['**/*.js', '**/*.mjs', '**/*.cjs'], languageOptions: { globals: NODE_GLOBALS } },
    { files: SCRIPT_FILES, rules: { 'no-console': 'off' } },
    ...(browserGlobs.length ? [{ files: browserGlobs, ignores: browserIgnores, rules: banNodeAndThree }] : []),
    ...(renderGlobs.length ? [{ files: renderGlobs, rules: renderOnlyBanNode }] : []),
    ...(simGlobs.length ? [{ files: simGlobs, rules: purity }] : []),
    { files: TEST_FILES, rules: { ...banThree, 'no-restricted-globals': 'off', 'no-restricted-properties': 'off', 'no-restricted-syntax': 'off', 'no-console': 'off' } },
    // A nested array in `files` matches when all its patterns match: test files in renderGlobs.
    ...(renderGlobs.length ? [{ files: renderGlobs.flatMap((glob) => TEST_FILES.map((test) => [glob, test])), rules: { 'no-restricted-imports': 'off' } }] : []),
    ...extra,
  );
}

export default conduitEslint();
```

Block order matters: the render block comes after the browser block so `packages/render/**` gets `three` allowed
while `node:*`/`ws` stay banned. The test block resets `no-restricted-imports` to the `three` ban alone, so test files
are exempt from purity and browser rules (including the `node:*`/`ws` import ban) but not from the `three` ban; the
last block lifts the import ban for test files inside `renderGlobs` (render tests read fixtures with `node:fs`).
Plain `.js`/`.mjs`/`.cjs` files (config files, scripts, bins) get Node's globals because `no-undef` still applies to
them, and `scripts/**` and `**/bin/**` may use `console` freely. Constructs covered by two purity rules on purpose
(`Date.now()`, `new Date()`, `performance.now()`, `setTimeout(...)`) report once per rule; the syntax/property rules
also catch an imported `setTimeout` or `performance` that `no-restricted-globals` cannot see.

### `prettier.config.js`

```js
/** @type {import('prettier').Config} */
export default {
  singleQuote: true,
  semi: true,
  trailingComma: 'all',
  printWidth: 100,
  tabWidth: 2,
  useTabs: false,
  endOfLine: 'lf',
  arrowParens: 'always',
};
```

### `vitest.preset.ts`

```ts
import { mergeConfig, type UserConfig } from 'vitest/config';

export interface ConduitVitestOptions {
  environment?: 'node' | 'jsdom';    // default 'node'; render and sandbox pass 'jsdom'
  include?: string[];                // default ['test/**/*.test.ts']
  setupFiles?: string[];
  testTimeout?: number;              // default 10_000 ms
  overrides?: UserConfig;            // deep-merged last
}

export function conduitVitest(opts: ConduitVitestOptions = {}): UserConfig {
  const base: UserConfig = {
    test: {
      environment: opts.environment ?? 'node',
      include: opts.include ?? ['test/**/*.test.ts'],
      exclude: ['**/node_modules/**', '**/dist/**', '**/e2e/**'],
      setupFiles: opts.setupFiles ?? [],
      testTimeout: opts.testTimeout ?? 10_000,
      globals: false,
      clearMocks: true,
      pool: 'forks',
      server: { deps: { inline: [/^@conduit\//] } },
    },
  };
  return opts.overrides ? mergeConfig(base, opts.overrides) : base;
}
```

Per-package `vitest.config.ts`:

```ts
import { conduitVitest } from '../tooling/vitest.preset.ts';
export default conduitVitest();                                  // node packages
export default conduitVitest({ environment: 'jsdom' });          // packages/render, examples/sandbox
```

Packages that need `node:sqlite` run their tests with no flag on Node 22.13+ and 24+: Spike 6 (M4) passed on Node
22.23.2, 24.21.0 and 26.7.0 without one (22.x prints an `ExperimentalWarning`). Only Node 22.5 to 22.12 needs
`NODE_OPTIONS=--experimental-sqlite` (CONCEPT.md risk 6); there the node:sqlite tests otherwise skip with
`openNodeSqlite`'s message. The flag has to come through `NODE_OPTIONS`: Vitest 3.2 has no `test.execArgv`, and
workspace projects cannot set `poolOptions.forks.execArgv`.

`examples/sandbox` also passes `overrides: { test: { passWithNoTests: true } }` while it has no unit tests. Vitest
honours it only when the sandbox config is the root config (its own `pnpm test`); the root workspace run passes
because other projects have tests.

### `vite.preset.ts`

```ts
import { mergeConfig, searchForWorkspaceRoot, type UserConfig } from 'vite';

export interface ConduitViteOptions {
  root?: string;             // default process.cwd()
  extraAllow?: string[];     // additional server.fs.allow entries (e.g. a sibling core checkout)
}

export function conduitVite(overrides: UserConfig = {}, opts: ConduitViteOptions = {}): UserConfig {
  const root = opts.root ?? process.cwd();
  const base: UserConfig = {
    resolve: { dedupe: ['three'] },
    optimizeDeps: { include: ['three'], exclude: [] },
    server: { fs: { allow: [searchForWorkspaceRoot(root), '..', ...(opts.extraAllow ?? [])] } },
    build: { target: 'es2022', sourcemap: true },
    esbuild: { target: 'es2022' },
  };
  return mergeConfig(base, overrides);
}
```

`resolve.dedupe: ['three']` makes every `import 'three'` (including those inside `vendor/conduit-core/packages/render`)
resolve from the app root, so one copy ships even if a second copy exists on disk. `optimizeDeps.include` pre-bundles
`three` once so dev never sees two ESM instances. `server.fs.allow` includes the pnpm workspace root (which contains
the submodule) plus `..`.

### `bin/conduit-assets.mjs`

```js
#!/usr/bin/env node
// Delegates to @conduit/assets/node (docs/assets.md). Sources are TypeScript; tsx compiles them on the fly.
import { register } from 'tsx/esm/api';

const unregister = register();
try {
  const { cli } = await import('@conduit/assets/node');
  process.exitCode = await cli(process.argv.slice(2));
} finally {
  await unregister();
}
```

`chmod +x` is committed. Invoked as `pnpm conduit-assets build examples/sandbox/assets examples/sandbox/public/assets --graph examples/sandbox/world.json`
from any workspace package that has `@conduit/tooling` as a devDependency. tsx's `unregister()` returns a promise, so it
is awaited. pnpm links a package's bins at install time and skips a bin whose file does not exist yet, so the first
`pnpm install` after `bin/conduit-assets.mjs` lands is what creates the `conduit-assets` shim; until then run
`node packages/tooling/bin/conduit-assets.mjs ...`.

### `src/index.ts`

```ts
export { conduitVitest, type ConduitVitestOptions } from '../vitest.preset.ts';
export { conduitVite, type ConduitViteOptions } from '../vite.preset.ts';
```

## 3. Per-package `package.json` template

```json
{
  "name": "@conduit/sim",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "sideEffects": false,
  "exports": {
    ".": { "types": "./src/index.ts", "default": "./src/index.ts" }
  },
  "scripts": {
    "typecheck": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "@conduit/math": "workspace:*",
    "@conduit/protocol": "workspace:*"
  },
  "devDependencies": {
    "@conduit/tooling": "workspace:*",
    "typescript": "^5.6.0",
    "vitest": "^3.1.0"
  }
}
```

Rules: `types` and `default` both point at the `.ts` source; no `main`, no `module`, no `files`. Packages with a
Node-only or test-only subpath add an `exports` entry per subpath in the same shape: `@conduit/assets/node`
(`./node` → `./src/node.ts`, docs/assets.md §6), `@conduit/persist/testing` (`./testing` → `./src/testing.ts`,
docs/persist.md 1.1), `@conduit/host/worker` (`./worker` → `./src/worker.ts`, the session worker entry a production
bundle builds, section 4 and docs/host.md §23) and the `@conduit/game` subpaths below. Every runtime
import of another core package is a `dependencies` entry with `workspace:*` (never `devDependencies`, or the game
install will not link it). `typescript` and `vitest` are declared per package so each is self-sufficient when only
`packages/*` is globbed by a game workspace (root devDependencies of core are never installed there).

`@conduit/game`:

```json
{
  "name": "@conduit/game",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "sideEffects": false,
  "exports": {
    ".":         { "types": "./src/index.ts",  "default": "./src/index.ts" },
    "./server":  { "types": "./src/server.ts", "default": "./src/server.ts" },
    "./client":  { "types": "./src/client.ts", "default": "./src/client.ts" },
    "./host":    { "types": "./src/host.ts",   "default": "./src/host.ts" }
  },
  "scripts": { "typecheck": "tsc -p tsconfig.json", "test": "vitest run" },
  "dependencies": {
    "@conduit/assets": "workspace:*", "@conduit/auth": "workspace:*", "@conduit/host": "workspace:*",
    "@conduit/lobby-client": "workspace:*", "@conduit/net-client": "workspace:*", "@conduit/net-server": "workspace:*",
    "@conduit/persist": "workspace:*", "@conduit/protocol": "workspace:*", "@conduit/render": "workspace:*",
    "@conduit/sim": "workspace:*", "@conduit/world": "workspace:*"
  },
  "devDependencies": { "@conduit/tooling": "workspace:*", "@types/node": "^22.10.0", "typescript": "^5.6.0", "vitest": "^3.1.0" }
}
```

`@conduit/render` is a normal dependency of `@conduit/game` (needed for types and the dynamic import in
`client.ts`); it is only *evaluated* when `createClient` receives a canvas (docs/game.md), which is what the
module-graph test in docs/render.md proves.

`@conduit/render`:

```json
{
  "name": "@conduit/render",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "sideEffects": false,
  "exports": { ".": { "types": "./src/index.ts", "default": "./src/index.ts" } },
  "scripts": { "typecheck": "tsc -p tsconfig.json", "test": "vitest run" },
  "dependencies": {
    "@conduit/assets": "workspace:*", "@conduit/math": "workspace:*", "@conduit/net-client": "workspace:*",
    "@conduit/protocol": "workspace:*", "@conduit/sim": "workspace:*", "@conduit/world": "workspace:*"
  },
  "peerDependencies": { "three": ">=0.160.0 <1.0.0", "@types/three": ">=0.160.0 <1.0.0" },
  "devDependencies": {
    "@conduit/tooling": "workspace:*", "@types/node": "^22.10.0", "@types/three": "0.170.0", "jsdom": "^25.0.0",
    "three": "0.170.0", "typescript": "^5.6.0", "vitest": "^3.1.0"
  }
}
```

`three` appears in render's `devDependencies` only so core's own tests and sandbox run; in a game workspace the app's
exact pin satisfies the peer and pnpm's `auto-install-peers` links the app's copy (single version, verified by
`check:three`).

## 4. No library build

Every package's `exports` resolves to `./src/index.ts`. That works because every consumer compiles TypeScript on
the fly:

| Consumer | How it reads `.ts` through the workspace symlink |
| --- | --- |
| Vite dev/build | esbuild transform on any resolved `.ts`; `server.fs.allow` permits the real path under `vendor/` |
| tsx (`tsx watch apps/host/src/main.ts`) | ESM loader hook compiles `.ts` wherever it resolves to |
| vitest | vite-node/vite transform; `server.deps.inline: [/^@conduit\//]` guarantees core sources are transformed rather than treated as prebuilt deps |
| esbuild (production host bundle) | bundles `.ts` directly |
| tsc (typecheck) | `moduleResolution: Bundler` honours `exports` and resolves `types: ./src/index.ts`, so declarations are the sources themselves |

Consequences: no `dist/`, no `.d.ts`, no `tsc -b`, no project references, and one TypeScript configuration (the
base) must be valid for every consumer. Go-to-definition lands in source.

### Production bundles

Host (`apps/host/build.mjs`):

```js
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Bundle workspace packages (they are TypeScript sources), keep everything else external.
const bundleWorkspace = {
  name: 'bundle-workspace',
  setup(b) {
    b.onResolve({ filter: /^(@conduit\/|@privateer\/)/ }, (args) => ({
      path: require.resolve(args.path, { paths: [args.resolveDir] }),
    }));
  },
};

await build({
  absWorkingDir: fileURLToPath(new URL('.', import.meta.url)), // apps/host: `pnpm build` runs here
  entryPoints: {
    main: 'src/main.ts',                   // the host's main thread (createHost)
    worker: '@conduit/host/worker',        // the session worker entry: createHost's workerEntry
    session: '@privateer/shared/session',  // the game module the workers import: the entry's module
  },
  outdir: 'dist/host',
  outExtension: { '.js': '.mjs' },         // dist/host/main.mjs, worker.mjs and session.mjs
  splitting: true,                         // code the entries share goes to chunks/, one copy of each module
  chunkNames: 'chunks/[name]-[hash]',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',            // ws, hono and every other node_modules package stay external
  plugins: [bundleWorkspace],      // ...except the workspace packages, which the plugin resolves to sources
  sourcemap: true,
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
```

Session workers do not run `main.mjs`. `SessionManager` spawns `@conduit/host`'s `worker.ts`, which it finds next to
its own module (docs/host.md §19); a bundle inlines that module, so the default names `dist/host/worker.ts` and every
join answers 500 after `worker_start_failed: Cannot find module '.../dist/host/worker.ts'`. The worker is therefore an
entry of its own (`@conduit/host/worker`, which is why `apps/host` declares `@conduit/host`, section 5), and `main.ts`
passes its output as `createHost`'s `workerEntry` (docs/game.md §3). The game module is the third entry, passed as
the game's `module`: with `splitting`, a worker and the module it imports load every module they share from the same
chunk. Registry-local identity now accepts equivalent component/event definitions from separate module copies,
but this shared-chunk recipe still avoids duplicate runtime modules and is the tested deployment layout.
Conflicting definitions are rejected. `main.ts` uses the outputs only when it runs bundled, since `pnpm dev`
runs the source through tsx:

```ts
// Bundled, this file is dist/host/main.mjs next to worker.mjs and session.mjs; under tsx the workers start from
// core's worker.ts (the default) and import the module's source.
const bundled = import.meta.url.endsWith('.mjs');
const host = await createHost(
  [{ game, module: bundled ? new URL('./session.mjs', import.meta.url) : import.meta.resolve('@privateer/shared/session') }],
  { port, dbPath, secret, workerEntry: bundled ? new URL('./worker.mjs', import.meta.url) : undefined },
);
```

`--packages=external` alone would externalise `@conduit/*` as well (they are bare specifiers), which is why the
plugin exists; the equivalent one-liner without the plugin, run in `apps/host`, is
`esbuild main=src/main.ts worker=@conduit/host/worker session=@privateer/shared/session --bundle --splitting --outdir=dist/host --out-extension:.js=.mjs '--chunk-names=chunks/[name]-[hash]' --platform=node --format=esm --target=node22 --external:ws --external:hono`.
`node:sqlite` is a built-in and needs nothing. Deploy `dist/host/` (the three entries and `chunks/`) plus a
`package.json` listing `ws`, `hono` and any package the game module imports, then `pnpm install --prod` there;
`node main.mjs` needs no TypeScript support. A Node flag that a worker's `execArgv` may not carry
(`node --max-old-space-size=4096 main.mjs`: `ERR_WORKER_INVALID_EXEC_ARGV`, so no session starts) needs
`createHost`'s `workerExecArgv: []`. The `require.resolve` in the plugin follows the `exports` map to
`src/index.ts`, so the bundle contains the TS-compiled sources; esbuild does not typecheck, so `pnpm typecheck` must
gate the build. `@conduit/game`'s `test/bundle.test.ts` builds and runs this recipe (docs/game.md §6).

Client: `vite build` in `apps/client` (config below) emits `apps/client/dist`; `three` is tree-shaken from the single
deduped copy. Pass `static: 'apps/client/dist'` in the second argument to `createHost(games, options)`
([host docs](host.md)), or serve the client through a CDN.

## 5. Consuming from a game repo

### Add and pin core

From your game repository, replacing the quoted placeholders with your core repository URL and
a reviewed commit available on that remote:

```sh
git submodule add '<core-repository-url>' vendor/conduit-core
git -C vendor/conduit-core checkout --detach '<reviewed-core-commit>'
git -C vendor/conduit-core submodule update --init --recursive
```

Create the workspace, manifests, and config files below, then run `pnpm install` from the game
root. Commit `.gitmodules`, the `vendor/conduit-core` gitlink, the game's manifests/configuration,
and its `pnpm-lock.yaml` together. The gitlink records the exact core commit, even if a branch or
tag later moves. Your collaborators and CI must be able to fetch that commit; private core
repositories need checkout credentials with access to both repositories.

For an existing game checkout:

```sh
git submodule update --init --recursive
pnpm install --frozen-lockfile
```

For a fresh checkout, `git clone --recurse-submodules '<game-repository-url>'` initializes core
at the recorded revision. Run pnpm from the game root; its workspace and lockfile govern this
installation. Core's own root workspace/lockfile remain useful when developing core independently.

### Layout

```
privateer/
  .gitmodules
  vendor/conduit-core/            git submodule, pinned commit (never edited in place; see pitfalls)
  apps/
    client/   package.json  vite.config.ts  tsconfig.json  index.html  src/main.ts
    host/     package.json  build.mjs       tsconfig.json  src/main.ts
  shared/     package.json  tsconfig.json   src/index.ts   (the GameDef: components, systems, world; imports @conduit/game)
                                          src/session.ts (the game module: game + sessionFactory; Node-only)
  package.json
  pnpm-workspace.yaml
  .npmrc
  tsconfig.json
  eslint.config.js
  prettier.config.js
  vitest.workspace.ts
  .github/workflows/ci.yml
```

### `pnpm-workspace.yaml`

```yaml
packages:
  - 'vendor/conduit-core/packages/*'
  - 'apps/*'
  - 'shared'

allowBuilds:
  esbuild: true
```

`vendor/conduit-core/examples/*` is deliberately not globbed (the sandbox is core's own test bed). `.npmrc` is the
same two lines as core's. `allowBuilds` is core's too (section 1): the core packages bring esbuild (under vite, vitest
and tsx), and pnpm 11 fails the install with `ERR_PNPM_IGNORED_BUILDS` when its build script is not allowed.

### Root `package.json`

```json
{
  "name": "privateer",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@11.21.0",
  "engines": { "node": ">=22" },
  "scripts": {
    "dev": "pnpm --filter @privateer/host dev & pnpm --filter @privateer/client dev",
    "dev:host": "pnpm --filter @privateer/host dev",
    "dev:client": "pnpm --filter @privateer/client dev",
    "build": "pnpm --filter @privateer/host build && pnpm --filter @privateer/client build",
    "typecheck": "pnpm -r --filter './apps/*' --filter './shared' run typecheck",
    "lint": "eslint . --max-warnings 0",
    "test": "vitest run",
    "check:three": "pnpm why -r three --json | node vendor/conduit-core/scripts/assert-single-three.mjs",
    "core:sync": "git submodule update --init --recursive"
  },
  "devDependencies": {
    "@conduit/tooling": "workspace:*",
    "@eslint/js": "^9.15.0", "eslint": "^9.15.0", "prettier": "^3.3.0",
    "typescript": "^5.6.0", "typescript-eslint": "^8.15.0", "vitest": "^3.1.0"
  }
}
```

`typecheck` filters to the game's own projects; core packages are typechecked in core's CI, and their sources are
still checked transitively wherever the app imports them. An unfiltered `pnpm -r typecheck` fails in a game workspace:
`@conduit/game`'s tests import `examples/sandbox`, which the game does not glob (TS2307 for its `@conduit/*` imports).
The game's `eslint.config.js` passes `ignores: ['vendor/**']` to `conduitEslint` (section 2) with its own globs;
without it `eslint .` also lints core's sources under the game's globs and fails (`no-restricted-imports` and more).

### Root `tsconfig.json`

```json
{
  "extends": "./vendor/conduit-core/packages/tooling/tsconfig.base.json",
  "include": []
}
```

Project tsconfigs extend this root file with a relative path (`"extends": "../../tsconfig.json"`, `"../tsconfig.json"`
from `shared`), add `lib`/`types` per the shapes in section 2, and `include: ["src", "test"]`. `apps/client` takes the
DOM `lib` without `types: ["node"]`: its manifest has no `@types/node`, and tsc then stops at `TS2688: Cannot find type
definition file for 'node'` without reporting any other error. `apps/host` and `shared` (whose `session.ts` imports
`@conduit/game/server`) take `types: ["node"]` and declare `@types/node`.

### `apps/client/package.json`

```json
{
  "name": "@privateer/client",
  "private": true,
  "type": "module",
  "scripts": { "dev": "vite", "build": "vite build", "preview": "vite preview", "typecheck": "tsc -p tsconfig.json" },
  "dependencies": {
    "@conduit/game": "workspace:*",
    "@conduit/lobby-client": "workspace:*",
    "@privateer/shared": "workspace:*",
    "three": "0.170.0"
  },
  "devDependencies": {
    "@conduit/tooling": "workspace:*",
    "@types/three": "0.170.0",
    "typescript": "^5.6.0",
    "vite": "^6.1.0"
  }
}
```

`three` is pinned exactly (no caret) and declared here only. `apps/host` and `shared` never depend on `three` or
`@types/three`. `@conduit/lobby-client` provides the `LobbyClient` that a host-mode client passes as `createClient`'s
`lobby` (docs/game.md §4); `@conduit/game/client` does not re-export it, and pnpm links only declared dependencies.

### `apps/client/vite.config.ts`

```ts
import { defineConfig } from 'vite';
import { conduitVite } from '@conduit/tooling/vite';

// The host's routes (docs/host.md 10, 17, 22) as whole path segments (a plain '/session' key would also take
// '/sessions'), WebSocket upgrades included. The object form keeps the Host header, so the page, its login
// cookie and the wsUrl the lobby derives from Host all stay on the dev server's origin.
const host = { target: 'http://localhost:8080', ws: true };
const paths = ['auth', 'me', 'games', 'sessions', 'friends', 'lobby', 'session', 'healthz'];

export default defineConfig(
  conduitVite({
    server: { port: 5173, proxy: Object.fromEntries(paths.map((p) => [`^/${p}(?:[/?]|$)`, host])) },
  }),
);
```

`examples/sandbox/vite.config.ts` uses the same list in host mode (`vite --mode host`).

### `apps/host/package.json`

```json
{
  "name": "@privateer/host",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch --clear-screen=false src/main.ts",
    "build": "node build.mjs",
    "start": "node dist/host/main.mjs",
    "typecheck": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "@conduit/game": "workspace:*", "@conduit/host": "workspace:*", "@privateer/shared": "workspace:*",
    "hono": "^4.6.0", "ws": "^8.18.0"
  },
  "devDependencies": { "@types/node": "^22.10.0", "@types/ws": "^8.5.0", "esbuild": "^0.24.0", "tsx": "^4.19.0", "typescript": "^5.6.0" }
}
```

`@conduit/host` is declared for `build.mjs`, whose `@conduit/host/worker` entry resolves from `apps/host` (pnpm links
only declared dependencies); `main.ts` itself imports only `@conduit/game/host`.

`apps/host/src/main.ts` imports `createHost` from `@conduit/game/host` (or `createServer` from
`@conduit/game/server` for single-session dev) and passes `{ game, module }` and `workerEntry` as section 4 shows:
bundled, the build's `session.mjs` and `worker.mjs`; under tsx, `import.meta.resolve('@privateer/shared/session')`
and core's own worker. `shared/src/session.ts` exports `game` and a `defineSessionFactory(...)` result (docs/game.md
§3); the session workers import that module themselves (docs/host.md §21). `createHost` requires `port`, `dbPath` and
`secret`, which `main.ts` takes from `PORT`, `DB_PATH` and `HOST_SECRET` (at least 32 bytes, else `ConfigError`;
docs/host.md §16). `shared/package.json` depends on `@conduit/game` and exports `./session` next to `.` (the section 3
shape), which both the `import.meta.resolve` and the `session` entry need.

`build.mjs` is section 4's; `pnpm build` runs it in `apps/host`, and it writes the `dist/host/main.mjs` that `start`
runs. Its entry paths are relative to `absWorkingDir`: with `packages: 'external'`, an entry path that is not a file
there is taken for a package (a repo-root `apps/host/src/main.ts` run in `apps/host`: `The entry point
"apps/host/src/main.ts" cannot be marked as external`), and a bundle written to the repo root cannot resolve `hono`.

### Dev loop

```
pnpm install
HOST_SECRET=<at least 32 bytes> pnpm dev:host   # tsx watch apps/host/src/main.ts  -> http://localhost:8080
pnpm dev:client                                 # vite                             -> http://localhost:5173, proxies to 8080
```

### CI steps (game repo)

```yaml
- uses: actions/checkout@v4
  with: { submodules: recursive }
- run: git submodule update --init --recursive        # belt and braces for runners that ignore the checkout option
- uses: pnpm/action-setup@v4
- uses: actions/setup-node@v4
  with: { node-version: 24, cache: pnpm }
- run: pnpm install --frozen-lockfile
- run: pnpm typecheck
- run: pnpm lint
- run: pnpm test
- run: pnpm check:three
- run: pnpm build
```

### Upgrade deliberately

Start with a clean core checkout and select a reviewed commit. From the game root:

```sh
git -C vendor/conduit-core fetch origin --tags
git -C vendor/conduit-core checkout --detach '<reviewed-core-commit>'
git -C vendor/conduit-core submodule update --init --recursive
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm check:three
pnpm build
git diff --submodule=log
```

Run the game's browser/integration checks too. Review and commit the new submodule pointer,
lockfile, and any game migrations together. CI uses the committed pointer and
`pnpm install --frozen-lockfile`. `core:sync` restores the revision already selected by the game;
it does not choose an upgrade. Avoid automatic `git submodule update --remote --merge` in
install/build/CI scripts: tracking the newest branch tip bypasses this review boundary.

Before adopting the improvements revision, check these separate migration surfaces:

- Wire v4 requires coordinated server/client bundles. The `protocolVersion` declared by a game
  is separate from core's wire version. Pin simulation revisions/gameplay digests when schema
  compatibility alone is insufficient.
- Replace global definition `.id` reads with the relevant registry's `componentId`/`eventId`.
  Use scoped `world.mutate` or tracked writes, and treat read views as deeply readonly.
- Use public `inputScheduling`/`pulseInput` and optional prediction/presentation adapters.
  Budgeted prediction must reconcile from coherent group state ticks, not just the snapshot header.
- Read new application saves with `openApplicationSave`; preserve legacy generations and supply
  explicit schema/compatibility migration adapters when necessary. Application saves and exact
  offline replay checkpoints are separate formats; rolling code back may require a compatible save.
- Keep the public eight-player limit. Review the [qualification results](implementation-harness.md)
  and [replication costs](bounded-replication.md) before setting resource budgets: failed performance
  qualifications are not overridden by a successful build or unit suite.

The [game facade](game.md), [network](net.md), [simulation](sim.md), and
[save migration](generation-saves.md) guides describe the replacement APIs.

### Sibling-checkout alternative (`link:`)

For hacking on core and a game simultaneously without submodule round-trips:

```
projects/
  conduit-core/     regular clone; run `pnpm install` here
  privateer/        game repo; vendor/conduit-core may be left uninitialised
```

In the game's `pnpm-workspace.yaml` drop the `vendor/...` glob; in each app/shared `package.json` replace
`"@conduit/game": "workspace:*"` with a `link:` to the sibling (and the same for `@conduit/tooling`). A `link:`
path is resolved **relative to the package that declares it**, so the depth differs per manifest: from `apps/*`
it is `"link:../../../conduit-core/packages/game"`, from `shared` `"link:../../conduit-core/packages/game"`, and
from the repo root (which declares `@conduit/tooling`) `"link:../conduit-core/packages/tooling"`. The root
`tsconfig.json` extends `../conduit-core/packages/tooling/tsconfig.base.json` and `check:three` runs
`node ../conduit-core/scripts/assert-single-three.mjs`. Add
`conduitVite({}, { extraAllow: ['../../../conduit-core'] })` (relative to the Vite project root, `apps/client`)
so Vite may serve the sibling. `link:` symlinks without installing the target's dependencies, so core must have
run its own `pnpm install`; core's `node_modules/three` (from render's devDependencies) is then on disk, and only
Vite's `resolve.dedupe` keeps the client on the app's copy. `check:three` is not meaningful in this mode: it
passes, because `pnpm why -r` only walks the game workspace and never sees core's copy, so the check that the
single instance actually holds is the browser one (no "Multiple instances of Three.js" warning). Switch back to
`workspace:*` before committing.

## 6. Pitfalls

| Pitfall | Symptom | Mitigation |
| --- | --- | --- |
| Duplicate `three` instances | `instanceof Object3D` false across modules, "Multiple instances of Three.js being imported" warning, materials silently wrong | `three` pinned exactly once in `apps/client`; render only peers it; `resolve.dedupe` + `optimizeDeps.include` in `conduitVite`; `pnpm check:three` in CI |
| Nested workspace file and lockfile in the submodule | pnpm run from inside `vendor/conduit-core` creates a second `node_modules` and dirties the submodule; `pnpm-lock.yaml` conflicts | Always run pnpm from the game root (use `--filter`); never `pnpm install` inside `vendor/`; core's lockfile is ignored by the game (the game's lockfile records core packages as workspace projects); the `node_modules` directories the game's install creates under `vendor/conduit-core/packages/*` stay out of the submodule's status through core's own `.gitignore` (`node_modules/`), while a game `.gitignore` entry for `vendor/conduit-core/node_modules` has no effect (a superproject's ignore rules do not apply inside a submodule) |
| Core root devDependencies not installed in the game | `vitest`/`typescript` missing when running a core package's script from the game | Every core package declares what its own `src`/`test` need in its own `package.json` (section 3); the core root `package.json` is orchestration only |
| No project references | Expecting `tsc -b` or per-package `.d.ts` | There are none by design (section 4); the game typechecks its own projects, which transitively check imported core sources; run core's own `pnpm typecheck` in core CI |
| Vite refuses to serve submodule files | `403 Restricted` / "The request url ... is outside of Vite serving allow list" | `conduitVite` sets `server.fs.allow` to the workspace root plus `..`; for sibling checkouts pass `extraAllow` |
| Submodule not initialised in CI | `vendor/conduit-core` empty; `pnpm install --frozen-lockfile` still exits 0 (the `workspace:*` links dangle) and `pnpm typecheck` fails with `TS5083: Cannot read file '.../vendor/conduit-core/packages/tooling/tsconfig.base.json'` (without that base's `noEmit`, tsc also writes `.js` files next to the sources); a non-frozen install fails with `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND` | `actions/checkout` with `submodules: recursive` and an explicit `git submodule update --init --recursive` |
| Strict-mode mismatch | Core sources fail typecheck inside the game (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax` differences) or pass in the game but not in core | The game root `tsconfig.json` extends the base via the submodule path and never overrides the flags in section 2; only `lib`, `types`, `include`, `paths` may be added |
| Updating the submodule pointer | Game builds against a stale or unreviewed core revision | Follow Upgrade deliberately: fetch, check out an explicit reviewed commit, run `pnpm install` and game checks, then commit the pointer, lockfile and game migrations together; `pnpm core:sync` only restores the recorded revision |
| `@types/three` version mismatch | Type errors inside `packages/render` about `Object3D`/`Material` members that exist at runtime | Pin `@types/three` to the same version as `three` in `apps/client`; render's peer range accepts it; never let a second `@types/three` land via a transitive devDependency (check `pnpm why @types/three`) |
| `.ts` presets on old Node | `ERR_UNKNOWN_FILE_EXTENSION .ts` when Vite/Vitest load `@conduit/tooling/vite` | Node `>=22.18` (or any 24.x) strips types natively; presets use only erasable syntax (no enums, no parameter properties); on older Node run with `NODE_OPTIONS=--import tsx` |
| `node:sqlite` on Node 22.5 to 22.12 | `ERR_UNKNOWN_BUILTIN_MODULE` (the message names the fix) | Run with `--experimental-sqlite` there (for example `NODE_OPTIONS=--experimental-sqlite`), or use Node 22.13+ or 24+, which need no flag (22.x prints an `ExperimentalWarning`; Spike 6, CONCEPT.md risk 6) |
| Bundled host without its own worker entry | `/healthz` answers but every join is 500; the log shows `worker_start_failed: Cannot find module '.../dist/host/worker.ts'` | Section 4's build: `@conduit/host/worker` and the game module are entries of the same `splitting` build, and `main.ts` passes their outputs as `workerEntry` and `module`; conflicting registry definitions still reject |
| Editing core inside `vendor/` | Changes live on a detached HEAD in the submodule and are lost or committed to the wrong repo | Treat `vendor/conduit-core` as read-only; develop core in its own clone (sibling-checkout mode), push, then bump the pointer |

## 7. CI for this repo

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) is the authoritative workflow. Its current layers are:

| Job | Checks |
| --- | --- |
| `check` | Frozen install, lint, formatting, workspace typecheck, unit/integration suites, exported deterministic network scenarios, single Three.js version |
| `e2e` | Separate Chromium, Firefox and WebKit jobs; fresh sandbox/host test servers and disposable databases; failure screenshots/traces/reports |
| `consume` | A fresh external workspace using only copied core packages/scripts; install, typecheck every public game entry plus command replay, single Three.js version, and no package `dist` dependency |
| `extended-timing` | Manual `workflow_dispatch` with `extended_checks: true`; the existing 600-second real-timer qualification |

CI targets Node 24 and the repository's pinned pnpm version. Report flags follow `pnpm test`
directly; pnpm 11 forwards a literal `--` to the script. Browser jobs select
`CONDUIT_BROWSER=chromium`, `firefox`, or `webkit` and install their matching Playwright builds.
Chromium uses SwiftShader and includes acknowledged debugger suspension/recovery; that test does
not establish physical hidden-tab throttling. `CI=1` disables reuse of an existing local dev server.

The consume job copies `packages/` and `scripts/`, excluding `node_modules`, without the sandbox
or core's root `package.json`. This tests the layout used by a submodule consumer and catches
accidental reliance on root-only dependencies. The outer workspace includes `allowBuilds: { esbuild: true }`
and `vendor/conduit-core/packages/*`; imports include `defineGame`, `createClient`, `createServer`,
`createHost`, and `createJournalReplayRun`. The game CI recipe in section 5 exercises the game's own
sources and production bundles separately.

[Scenario documentation](implementation-harness.md) explains reproducible inputs, measurement
scope, and failed performance/resource qualifications. The [README](../README.md#current-contracts-and-limits)
records the latest functional verification totals and intentional skip. A green CI suite does
not convert failed workload qualifications into a production capacity guarantee.

## 8. Files

### packages/tooling

| File | Exports / contents |
| --- | --- |
| `package.json` | section 2 |
| `tsconfig.base.json` | section 2 |
| `tsconfig.json` | `{ "extends": "./tsconfig.base.json", "compilerOptions": { "types": ["node"], "allowJs": true }, "include": ["src", "test", "vitest.preset.ts", "vite.preset.ts"] }` (`allowJs` without `checkJs` so `test/eslint-rules.test.ts` can import `eslint.config.js` with its JSDoc types) |
| `eslint.config.js` | `conduitEslint(opts)`, default export `conduitEslint()` |
| `prettier.config.js` | default export config object |
| `vitest.preset.ts` | `conduitVitest`, `ConduitVitestOptions` |
| `vite.preset.ts` | `conduitVite`, `ConduitViteOptions` |
| `bin/conduit-assets.mjs` | executable; registers tsx, calls `cli` from `@conduit/assets/node`, sets `process.exitCode` |
| `src/index.ts` | re-exports `conduitVitest`, `conduitVite` and their option types |
| `vitest.config.ts` | `conduitVitest()` |

### packages/tooling/test

| File | Proves |
| --- | --- |
| `eslint-rules.test.ts` | using `ESLint` from `eslint` with `conduitEslint({ simGlobs: ['fixtures/sim/**'], renderGlobs: ['fixtures/render/**'], browserGlobs: ['fixtures/browser/**'] })` on in-memory fixture files: `Math.random()`, `Date.now()`, `new Date()`, `performance.now()`, `setTimeout(fn, 0)`, `globalThis.setInterval(fn, 1000)` and an imported `setTimeout` in a sim file each produce only purity-message errors, exactly one per covering rule (the rule ids are pinned; see section 2); the same code in a non-sim file produces none; `import * as THREE from 'three'` and `import { X } from 'three/addons/x.js'` error outside `renderGlobs` and pass inside; `import 'node:fs'`, `import 'fs'`, `import 'ws'` and a bare `process.env` error in browser files and pass in render's test files, while `node:fs`/`ws` stay banned in render sources; test files are exempt from purity but not from the `three` ban; in `.mjs` files under `scripts/` and `bin/`, `process` and `console.log` produce nothing, another `.js` file gets only the `no-console` warning, an undeclared global still fails `no-undef`, and a `.js` browser file still fails on `process` |
| `tsconfig.test.ts` | `tsconfig.base.json` parses with `ts.parseJsonConfigFileContent` without diagnostics and yields `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noEmit`, `isolatedModules`, `verbatimModuleSyntax` all `true`, `types: []`, `moduleResolution: Bundler`, `target: ES2022`; a fixture package tsconfig extending it via relative path resolves the same options |
| `presets.test.ts` | `conduitVitest()` returns node env and `test/**/*.test.ts`; `{ environment: 'jsdom' }` overrides; `overrides` deep-merge; `conduitVite()` contains `resolve.dedupe: ['three']`, `optimizeDeps.include: ['three']`, `server.fs.allow` including `'..'` and the workspace root; user overrides merge without dropping the dedupe |
| `bin.test.ts` | the bin is executable with a `#!/usr/bin/env node` shebang (skipped on Windows); spawning `bin/conduit-assets.mjs --help` with `process.execPath` exits 1 and prints usage; `build` on a two-file temp dir exits 0 and writes `manifest.json` (delegation to `@conduit/assets/node` works through tsx); `check` of an invalid manifest exits 2 with `manifest_invalid` on stderr |

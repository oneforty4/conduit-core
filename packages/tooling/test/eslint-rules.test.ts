import { ESLint, type Linter } from 'eslint';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { conduitEslint } from '../eslint.config.js';

const PURITY =
  'Sim code is pure: no wall clock, Math.random or timers (CONCEPT.md principle 3). Use ctx.rng / ctx.tick.';
const THREE_MESSAGE = 'Only @conduit/render may import three (CONCEPT.md principle 1).';
const NODE_MESSAGE = 'Browser packages may not import Node built-ins or ws.';

// Fixture files are in-memory: lintText never reads `filePath`; globs match it relative to `cwd`.
// The cast bridges typescript-eslint's config type and ESLint's, which differ under
// exactOptionalPropertyTypes.
const eslint = new ESLint({
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  overrideConfigFile: true,
  overrideConfig: conduitEslint({
    simGlobs: ['fixtures/sim/**'],
    renderGlobs: ['fixtures/render/**'],
    browserGlobs: ['fixtures/browser/**'],
  }) as Linter.Config[],
});

async function lint(filePath: string, code: string) {
  const [result] = await eslint.lintText(code, { filePath });
  if (!result) throw new Error(`no lint result for ${filePath}`);
  return result.messages.map(({ ruleId, severity, message }) => ({ ruleId, severity, message }));
}

const error = (ruleId: string, message: string) => ({
  ruleId,
  severity: 2,
  message: expect.stringContaining(message),
});

describe('sim purity', () => {
  // [construct, code, rules reporting it, in report order]. Some constructs are covered by two
  // rules on purpose: the syntax/property rules also catch an imported `setTimeout` or
  // `performance`, which `no-restricted-globals` cannot see. Each covering rule reports once.
  const impure: [string, string, string[]][] = [
    ['Math.random()', 'export const r = Math.random();', ['no-restricted-properties']],
    [
      'Date.now()',
      'export const t = Date.now();',
      ['no-restricted-globals', 'no-restricted-properties'],
    ],
    [
      'new Date()',
      'export const d = new Date();',
      ['no-restricted-syntax', 'no-restricted-globals'],
    ],
    [
      'performance.now()',
      'export const t = performance.now();',
      ['no-restricted-globals', 'no-restricted-properties'],
    ],
    [
      'setTimeout(fn, 0)',
      'const fn = (): void => {};\nsetTimeout(fn, 0);',
      ['no-restricted-globals', 'no-restricted-syntax'],
    ],
    [
      'globalThis.setInterval',
      'const fn = (): void => {};\nglobalThis.setInterval(fn, 1000);',
      ['no-restricted-syntax'],
    ],
    [
      'an imported setTimeout',
      "import { setTimeout } from 'node:timers';\nconst fn = (): void => {};\nsetTimeout(fn, 0);",
      ['no-restricted-syntax'],
    ],
  ];

  it.each(impure)(
    '%s in a sim file reports only the purity message',
    async (_name, code, rules) => {
      expect(await lint('fixtures/sim/impure.ts', code)).toEqual(
        rules.map((ruleId) => error(ruleId, PURITY)),
      );
    },
  );

  it.each(impure)('%s in a non-sim file is allowed', async (_name, code) => {
    expect(await lint('fixtures/other/impure.ts', code)).toEqual([]);
  });

  it.each(impure)('%s in a sim test file is allowed', async (_name, code) => {
    expect(await lint('fixtures/sim/test/impure.test.ts', code)).toEqual([]);
  });

  it('bare sort() is reported in sim files only', async () => {
    const code = 'export const sorted = [3, 1, 2].sort();';
    expect(await lint('fixtures/sim/sort.ts', code)).toEqual([
      error('no-restricted-syntax', 'explicit comparator'),
    ]);
    expect(await lint('fixtures/other/sort.ts', code)).toEqual([]);
  });
});

describe('three quarantine', () => {
  const imports: [string, string][] = [
    [
      "import * as THREE from 'three'",
      "import * as THREE from 'three';\nexport const origin = new THREE.Vector3();",
    ],
    [
      "import { X } from 'three/addons/x.js'",
      "import { X } from 'three/addons/x.js';\nexport { X };",
    ],
  ];
  const outside = [
    'fixtures/other/scene.ts',
    'fixtures/sim/scene.ts',
    'fixtures/browser/scene.ts',
    'fixtures/other/test/scene.test.ts',
    'fixtures/sim/test/scene.test.ts',
  ];
  const inside = ['fixtures/render/src/scene.ts', 'fixtures/render/test/scene.test.ts'];

  describe.each(imports)('%s', (_name, code) => {
    it.each(outside)('errors outside renderGlobs: %s', async (file) => {
      expect(await lint(file, code)).toEqual([error('no-restricted-imports', THREE_MESSAGE)]);
    });

    it.each(inside)('passes inside renderGlobs: %s', async (file) => {
      expect(await lint(file, code)).toEqual([]);
    });
  });
});

describe('browser files', () => {
  const nodeAccess: [string, string, string][] = [
    ["import 'node:fs'", "import 'node:fs';", 'no-restricted-imports'],
    ["import 'fs'", "import 'fs';", 'no-restricted-imports'],
    ["import 'ws'", "import 'ws';", 'no-restricted-imports'],
    ['a bare process.env', 'export const env = process.env;', 'no-restricted-globals'],
  ];

  it.each(nodeAccess)('%s errors in a browser file', async (_name, code, ruleId) => {
    expect(await lint('fixtures/browser/client.ts', code)).toEqual([error(ruleId, NODE_MESSAGE)]);
  });

  it.each(nodeAccess)("%s passes in render's test files", async (_name, code) => {
    expect(await lint('fixtures/render/test/loader.test.ts', code)).toEqual([]);
  });

  it.each(["import 'node:fs';", "import 'ws';"])('render sources still ban %s', async (code) => {
    expect(await lint('fixtures/render/src/loader.ts', code)).toEqual([
      error('no-restricted-imports', NODE_MESSAGE),
    ]);
  });
});

describe('plain JavaScript files (Node globals block)', () => {
  const script = 'console.log(process.argv.slice(2));\nprocess.exitCode = 0;';

  it.each(['scripts/check.mjs', 'bin/conduit-assets.mjs'])(
    '%s may use Node globals and console',
    async (file) => {
      expect(await lint(file, script)).toEqual([]);
    },
  );

  it('other .js files get Node globals but keep the no-console warning', async () => {
    expect(await lint('fixtures/other/tool.js', script)).toEqual([
      { ruleId: 'no-console', severity: 1, message: expect.any(String) },
    ]);
  });

  it('undeclared identifiers still fail no-undef', async () => {
    expect(await lint('scripts/check.mjs', 'export const body = document.body;')).toEqual([
      error('no-undef', "'document' is not defined"),
    ]);
  });

  it('declared Node globals do not lift the browser process ban', async () => {
    expect(await lint('fixtures/browser/legacy.js', 'export const env = process.env;')).toEqual([
      error('no-restricted-globals', NODE_MESSAGE),
    ]);
  });
});

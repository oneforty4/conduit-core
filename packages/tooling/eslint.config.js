import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const THREE_MESSAGE = 'Only @conduit/render may import three (CONCEPT.md principle 1).';
const NODE_MESSAGE = 'Browser packages may not import Node built-ins or ws.';
const PURITY =
  'Sim code is pure: no wall clock, Math.random or timers (CONCEPT.md principle 3). Use ctx.rng / ctx.tick.';
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
    'no-restricted-imports': [
      'error',
      { patterns: [{ group: ['three', 'three/*'], message: THREE_MESSAGE }] },
    ],
  };
  const banNodeAndThree = {
    'no-restricted-imports': [
      'error',
      {
        paths: [{ name: 'ws', message: NODE_MESSAGE }],
        patterns: [
          { group: ['three', 'three/*'], message: THREE_MESSAGE },
          {
            group: [
              'node:*',
              'fs',
              'path',
              'crypto',
              'worker_threads',
              'child_process',
              'http',
              'https',
              'net',
              'os',
              'url',
              'util',
              'stream',
              'events',
            ],
            message: NODE_MESSAGE,
          },
        ],
      },
    ],
    'no-restricted-globals': [
      'error',
      { name: 'process', message: NODE_MESSAGE },
      { name: 'Buffer', message: NODE_MESSAGE },
    ],
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
      {
        selector:
          "CallExpression[callee.object.name='globalThis'][callee.property.name=/^(setTimeout|setInterval|setImmediate)$/]",
        message: PURITY,
      },
      { selector: "NewExpression[callee.name='Date']", message: PURITY },
      {
        selector: "CallExpression[callee.property.name='sort'][arguments.length=0]",
        message: 'Sim code sorts with an explicit comparator (docs/sim.md 2.12 rule 4).',
      },
    ],
  };

  return tseslint.config(
    {
      ignores: [
        '**/node_modules/**',
        '**/dist/**',
        '**/coverage/**',
        '**/playwright-report/**',
        '**/test-results/**',
        ...ignores,
      ],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
      files: ['**/*.ts', '**/*.mts', '**/*.js', '**/*.mjs'],
      rules: {
        ...banThree,
        '@typescript-eslint/consistent-type-imports': [
          'error',
          { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
        ],
        '@typescript-eslint/no-unused-vars': [
          'error',
          { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
        ],
        '@typescript-eslint/no-explicit-any': 'error',
        'no-console': ['warn', { allow: ['warn', 'error'] }],
      },
    },
    { files: ['**/*.js', '**/*.mjs', '**/*.cjs'], languageOptions: { globals: NODE_GLOBALS } },
    { files: SCRIPT_FILES, rules: { 'no-console': 'off' } },
    ...(browserGlobs.length
      ? [{ files: browserGlobs, ignores: browserIgnores, rules: banNodeAndThree }]
      : []),
    ...(renderGlobs.length ? [{ files: renderGlobs, rules: renderOnlyBanNode }] : []),
    ...(simGlobs.length ? [{ files: simGlobs, rules: purity }] : []),
    {
      files: TEST_FILES,
      rules: {
        ...banThree,
        'no-restricted-globals': 'off',
        'no-restricted-properties': 'off',
        'no-restricted-syntax': 'off',
        'no-console': 'off',
      },
    },
    // A nested array in `files` matches when all its patterns match: test files in renderGlobs.
    ...(renderGlobs.length
      ? [
          {
            files: renderGlobs.flatMap((glob) => TEST_FILES.map((test) => [glob, test])),
            rules: { 'no-restricted-imports': 'off' },
          },
        ]
      : []),
    ...extra,
  );
}

export default conduitEslint();

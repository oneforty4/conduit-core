import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { conduitVite } from '../vite.preset.ts';
import { conduitVitest } from '../vitest.preset.ts';

const toolingDir = fileURLToPath(new URL('..', import.meta.url));
const workspaceRoot = path.resolve(toolingDir, '..', '..');

describe('conduitVitest', () => {
  it('defaults to the node environment and test/**/*.test.ts', () => {
    const { test } = conduitVitest();
    expect(test?.environment).toBe('node');
    expect(test?.include).toEqual(['test/**/*.test.ts']);
    expect(test?.server?.deps?.inline).toEqual([/^@conduit\//]);
  });

  it('lets { environment: "jsdom" } override the environment', () => {
    const { test } = conduitVitest({ environment: 'jsdom' });
    expect(test?.environment).toBe('jsdom');
    expect(test?.include).toEqual(['test/**/*.test.ts']);
  });

  it('deep-merges overrides last', () => {
    const { test } = conduitVitest({
      testTimeout: 5_000,
      overrides: { test: { testTimeout: 30_000, server: { deps: { inline: ['some-dep'] } } } },
    });
    expect(test?.testTimeout).toBe(30_000);
    expect(test?.server?.deps?.inline).toEqual([/^@conduit\//, 'some-dep']);
    expect(test?.environment).toBe('node');
    expect(test?.include).toEqual(['test/**/*.test.ts']);
    expect(test?.pool).toBe('forks');
  });
});

describe('conduitVite', () => {
  it('dedupes and pre-bundles three and allows the workspace root plus ..', () => {
    const config = conduitVite({}, { root: toolingDir });
    expect(config.resolve?.dedupe).toEqual(['three']);
    expect(config.optimizeDeps?.include).toEqual(['three']);
    expect(config.server?.fs?.allow).toContain('..');
    expect(config.server?.fs?.allow).toContain(workspaceRoot);
  });

  it('defaults root to process.cwd() and appends extraAllow', () => {
    const config = conduitVite({}, { extraAllow: ['../../../conduit-core'] });
    expect(config.server?.fs?.allow).toContain(workspaceRoot);
    expect(config.server?.fs?.allow).toContain('../../../conduit-core');
  });

  it('merges user overrides without dropping the dedupe', () => {
    const config = conduitVite({
      resolve: { dedupe: ['react'] },
      server: { port: 5173, fs: { allow: ['/srv/assets'] } },
    });
    expect(config.resolve?.dedupe).toEqual(['three', 'react']);
    expect(config.optimizeDeps?.include).toEqual(['three']);
    expect(config.server?.port).toBe(5173);
    expect(config.server?.fs?.allow).toEqual(expect.arrayContaining(['..', '/srv/assets']));
  });
});

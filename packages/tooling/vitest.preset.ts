import { mergeConfig, type UserConfig } from 'vitest/config';

export interface ConduitVitestOptions {
  environment?: 'node' | 'jsdom'; // default 'node'; render and sandbox pass 'jsdom'
  include?: string[]; // default ['test/**/*.test.ts']
  setupFiles?: string[];
  testTimeout?: number; // default 10_000 ms
  overrides?: UserConfig; // deep-merged last
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

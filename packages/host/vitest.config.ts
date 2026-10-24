import { conduitVitest } from '../tooling/vitest.preset.ts';

// Host tests start worker threads, child processes and scrypt logins; give them room on a busy machine.
export default conduitVitest({ testTimeout: 30_000, overrides: { test: { hookTimeout: 30_000 } } });

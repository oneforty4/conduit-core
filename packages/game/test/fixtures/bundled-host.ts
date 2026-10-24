// The main thread of the production bundle in test/bundle.test.ts: the `main` entry of one esbuild
// build whose `worker` (@conduit/host/worker) and `session` (the sandbox's game module) outputs sit
// next to this file's (docs/consuming.md 4). HOST_SECRET and DB_PATH come from the environment.
import { game } from '../../../../examples/sandbox/src/shared/game.ts';
import { createHost } from '../../src/host.ts';

const host = await createHost([{ game, module: new URL('./session.mjs', import.meta.url) }], {
  port: 0,
  dbPath: process.env.DB_PATH ?? ':memory:',
  secret: process.env.HOST_SECRET ?? '',
  workerEntry: new URL('./worker.mjs', import.meta.url),
  // The test starts this process with --max-old-space-size, which a worker's execArgv may not carry.
  workerExecArgv: [],
});
process.stdout.write(`listening on ${host.url}\n`);

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

import { conduitEslint } from './packages/tooling/eslint.config.js';

export default conduitEslint({
  simGlobs: [
    'packages/math/src/**',
    'packages/protocol/src/**',
    'packages/sim/src/**',
    'packages/world/src/**',
  ],
  // The sandbox's scene setup stands in for a game client app's own three code (docs/consuming.md 5).
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
  browserIgnores: [
    'packages/assets/src/node.ts',
    'packages/assets/src/build.ts',
    'packages/assets/src/check.ts',
    'packages/assets/src/cli.ts',
  ],
});

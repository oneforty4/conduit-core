// The sandbox's game module (docs/game.md 3, docs/host.md 21): exactly `game` and `sessionFactory`.
// The host CLI and its session workers import this file from M5; `main.ts` uses the same parts.
import { defineSessionFactory } from '@conduit/game/server';
import { game } from '../shared/game.ts';
import { createHooks } from './hooks.ts';
import { SandboxLoader } from './loader.ts';

export { game };

export const sessionFactory = defineSessionFactory(game, () => ({
  regionLoader: new SandboxLoader(),
  hooks: createHooks(),
}));

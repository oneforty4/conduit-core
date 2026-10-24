// Isomorphic root entry (docs/game.md 5, 6): protocol, sim and world only. Node-only code lives in
// ./server; the client in ./client.
export { defineGame } from './defineGame.ts';
export { GameDefError, type GameDefErrorCode } from './validate.ts';
export type { Game, GameDefInput } from './types.ts';

export {
  CORE_COMPONENTS,
  defineComponent,
  defineEvent,
  defineSystem,
  Model,
  Name,
  Owner,
  Region,
  Transform,
} from '@conduit/sim';
export { defineInput, defineMessage, f } from '@conduit/protocol';
export { GridWorld, NodeWorld } from '@conduit/world';

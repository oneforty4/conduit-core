import type { SessionState } from './api.ts';
import { LobbyError } from './errors.ts';

/** The game-session state machine (docs/host.md section 8). `archived` is terminal. */
export const SESSION_TRANSITIONS: Record<SessionState, SessionState[]> = {
  created: ['running', 'archived'],
  running: ['idle', 'archived'],
  idle: ['running', 'archived'],
  archived: [],
};

/** Throws `LobbyError('conflict')` unless `from → to` is in SESSION_TRANSITIONS. */
export function assertTransition(from: SessionState, to: SessionState): void {
  if (!Object.hasOwn(SESSION_TRANSITIONS, from) || !SESSION_TRANSITIONS[from].includes(to)) {
    throw new LobbyError('conflict', `a session cannot go from ${from} to ${to}`);
  }
}

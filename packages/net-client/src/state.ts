/** `NetClient` connection states (docs/net.md B.3). */
export type ClientState =
  | 'Disconnected'
  | 'Connecting'
  | 'Handshaking'
  | 'Joined'
  | 'Loading'
  | 'Ready'
  | 'Playing'
  | 'Reconnecting'
  | 'Resyncing';

export const CLIENT_STATES: readonly ClientState[] = Object.freeze([
  'Disconnected',
  'Connecting',
  'Handshaking',
  'Joined',
  'Loading',
  'Ready',
  'Playing',
  'Reconnecting',
  'Resyncing',
]);

/**
 * The B.3 edge table: `CLIENT_TRANSITIONS[from]` lists every state `from` may move to. Staying in a
 * state is not a transition. Every state except Disconnected may reach Disconnected (`disconnect()`,
 * a final close, Rejected, three bad frames). The Reconnecting and Resyncing edges are driven by
 * `NetClient` from M4 (PLAN.md).
 */
export const CLIENT_TRANSITIONS: Readonly<Record<ClientState, readonly ClientState[]>> =
  Object.freeze({
    Disconnected: Object.freeze(['Connecting'] as const),
    Connecting: Object.freeze(['Handshaking', 'Disconnected'] as const),
    Handshaking: Object.freeze(['Joined', 'Disconnected'] as const),
    Joined: Object.freeze(['Loading', 'Disconnected'] as const),
    Loading: Object.freeze(['Ready', 'Disconnected'] as const),
    Ready: Object.freeze(['Playing', 'Loading', 'Disconnected'] as const),
    Playing: Object.freeze(['Reconnecting', 'Disconnected'] as const),
    Reconnecting: Object.freeze(['Resyncing', 'Joined', 'Disconnected'] as const),
    Resyncing: Object.freeze(['Playing', 'Reconnecting', 'Disconnected'] as const),
  });

export function canTransition(from: ClientState, to: ClientState): boolean {
  return CLIENT_TRANSITIONS[from].includes(to);
}

/** Throws `Error` unless `from -> to` is an edge of `CLIENT_TRANSITIONS`. */
export function assertTransition(from: ClientState, to: ClientState): void {
  if (!canTransition(from, to)) {
    throw new Error(`NetClient: illegal state transition ${from} -> ${to}`);
  }
}

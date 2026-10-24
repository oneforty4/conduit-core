export type HostErrorCode =
  | 'unknown_game' // start() for a game id that was never registered
  | 'no_game_module' // the game was registered without a module location
  | 'worker_start_timeout' // the worker did not post `ready` within WORKER_READY_TIMEOUT_MS
  | 'worker_start_failed' // the worker failed (fatal, error or exit) before `ready`
  | 'not_running'; // an operation needed a running session

/** Errors of the host's session management (docs/host.md 19). */
export class HostError extends Error {
  override readonly name = 'HostError';
  readonly code: HostErrorCode;

  constructor(code: HostErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}

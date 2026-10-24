import type { LobbyErrorCode } from '@conduit/lobby';

/**
 * A failed lobby call (docs/host.md §12). `code` and `field` come from the lobby's `ErrorResponse`
 * body and `status` is the HTTP status; a failure response whose body is not an `ErrorResponse` is
 * `'internal'`, and a request that never produced a response (`fetch` rejected) is `'network'`
 * with `status` 0.
 */
export class LobbyError extends Error {
  override readonly name = 'LobbyError';
  readonly code: LobbyErrorCode | 'network';
  /** The HTTP status of the response; 0 for `'network'`. */
  readonly status: number;
  /** The request field that failed validation, when the lobby named one. */
  readonly field?: string;

  constructor(
    code: LobbyErrorCode | 'network',
    status: number,
    message: string,
    options: { field?: string; cause?: unknown } = {},
  ) {
    super(message, 'cause' in options ? { cause: options.cause } : undefined);
    this.code = code;
    this.status = status;
    if (options.field !== undefined) this.field = options.field;
  }
}

import { ERROR_STATUS, type LobbyErrorCode } from './api.ts';

/**
 * A deliberate lobby failure (docs/host.md section 6). Routes answer it with `status` and an
 * `ErrorResponse` body `{ error: code, message, field? }`.
 */
export class LobbyError extends Error {
  override readonly name = 'LobbyError';
  readonly code: LobbyErrorCode;
  /** `ERROR_STATUS[code]`. */
  readonly status: number;
  /** The request field that failed validation, when there is one. */
  readonly field?: string;

  constructor(
    code: LobbyErrorCode,
    message: string,
    options: { field?: string; cause?: unknown } = {},
  ) {
    super(message, 'cause' in options ? { cause: options.cause } : undefined);
    this.code = code;
    this.status = ERROR_STATUS[code];
    if (options.field !== undefined) this.field = options.field;
  }
}

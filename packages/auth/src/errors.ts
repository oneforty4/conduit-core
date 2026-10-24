export type AuthErrorCode =
  | 'password_length' // hashPassword: password outside MIN_PASSWORD_BYTES..MAX_PASSWORD_BYTES
  | 'weak_secret' // HMAC secret shorter than MIN_SECRET_BYTES UTF-8 bytes (a deployment error)
  | 'bad_payload' // mintToken: payload that verifyToken would never accept
  | 'bad_encoding'; // base64urlDecode: character outside [A-Za-z0-9_-]

/** Thrown by @conduit/auth for caller or deployment errors; bad tokens return `null` instead. */
export class AuthError extends Error {
  override readonly name = 'AuthError';
  readonly code: AuthErrorCode;

  constructor(code: AuthErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

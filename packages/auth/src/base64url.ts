import { AuthError } from './errors.ts';

const BASE64URL_RE = /^[A-Za-z0-9_-]*$/;

/** Unpadded base64url (RFC 4648 section 5) of `bytes`; a string is encoded as UTF-8 first. */
export function base64url(bytes: Uint8Array | string): string {
  const buffer = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : Buffer.from(bytes);
  return buffer.toString('base64url');
}

/**
 * Decodes unpadded base64url. Throws `AuthError('bad_encoding')` on any character outside
 * `[A-Za-z0-9_-]` (padding and whitespace included), which Node's decoder would silently skip.
 */
export function base64urlDecode(s: string): Buffer {
  if (typeof s !== 'string' || !BASE64URL_RE.test(s)) {
    throw new AuthError('bad_encoding', 'base64url input may only contain [A-Za-z0-9_-]');
  }
  return Buffer.from(s, 'base64url');
}

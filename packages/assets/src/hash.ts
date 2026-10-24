import type { Sha256Sri } from './manifest.ts';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const SHA256_BYTES = 32;

/** Standard base64 (RFC 4648 §4) with `=` padding. Isomorphic: no `Buffer`, no `btoa`. */
export function base64Encode(bytes: Uint8Array): string {
  let out = '';
  const whole = bytes.length - (bytes.length % 3);
  for (let i = 0; i < whole; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out +=
      ALPHABET.charAt((n >> 18) & 63) +
      ALPHABET.charAt((n >> 12) & 63) +
      ALPHABET.charAt((n >> 6) & 63) +
      ALPHABET.charAt(n & 63);
  }
  const rest = bytes.length - whole;
  if (rest > 0) {
    const n = ((bytes[whole] ?? 0) << 16) | (rest === 2 ? (bytes[whole + 1] ?? 0) << 8 : 0);
    out += ALPHABET.charAt((n >> 18) & 63) + ALPHABET.charAt((n >> 12) & 63);
    out += rest === 2 ? `${ALPHABET.charAt((n >> 6) & 63)}=` : '==';
  }
  return out;
}

/** `'sha256-' + base64(digest)`. Throws `RangeError` unless `digest` is 32 bytes. */
export function sriFromDigest(digest: Uint8Array): Sha256Sri {
  if (digest.length !== SHA256_BYTES) {
    throw new RangeError(`a sha256 digest is ${SHA256_BYTES} bytes, got ${digest.length}`);
  }
  return `sha256-${base64Encode(digest)}`;
}

/**
 * A plain `ArrayBuffer` with exactly `bytes`: the view's own buffer when it spans all of it, else a
 * copy. WebCrypto's `BufferSource` (DOM lib) does not accept views over a possibly shared buffer.
 */
function toArrayBuffer(bytes: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (!ArrayBuffer.isView(bytes)) return bytes;
  const { buffer } = bytes;
  if (
    buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === buffer.byteLength
  ) {
    return buffer;
  }
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

/** SHA-256 of `bytes` in SRI form, via `crypto.subtle` (browsers and Node >= 20). */
export async function sha256Sri(bytes: ArrayBuffer | Uint8Array): Promise<Sha256Sri> {
  const digest = await crypto.subtle.digest('SHA-256', toArrayBuffer(bytes));
  return sriFromDigest(new Uint8Array(digest));
}

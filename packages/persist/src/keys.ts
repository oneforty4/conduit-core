import { BlobStoreError } from './errors.ts';

/** Only `[a-z_]`, so a namespace can be interpolated into a SQL identifier without quoting. */
export const NAMESPACE_RE = /^[a-z_]+$/;
export const MAX_NAMESPACE_CHARS = 64;
/** Limit on the UTF-8 encoding of a key or list prefix. */
export const MAX_KEY_BYTES = 256;
/** 64 MiB. */
export const MAX_BLOB_BYTES = 67_108_864;

const PREVIEW_CHARS = 40;

function preview(s: string): string {
  return JSON.stringify(s.length > PREVIEW_CHARS ? `${s.slice(0, PREVIEW_CHARS)}...` : s);
}

/** UTF-8 byte length of `s`, or -1 when `s` is not well-formed (contains a lone surrogate). */
function wellFormedUtf8Length(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) {
      bytes += 1;
    } else if (c < 0x800) {
      bytes += 2;
    } else if (c < 0xd800 || c > 0xdfff) {
      bytes += 3;
    } else if (c <= 0xdbff && isLowSurrogate(s.charCodeAt(i + 1))) {
      bytes += 4; // surrogate pair: one supplementary code point
      i++;
    } else {
      return -1;
    }
  }
  return bytes;
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

/** Throws `BlobStoreError('bad_namespace')` unless `ns` matches NAMESPACE_RE and has 1..64 chars. */
export function validateNamespace(ns: string): void {
  if (typeof ns !== 'string') {
    throw new BlobStoreError('bad_namespace', `namespace must be a string, got ${typeof ns}`);
  }
  if (ns.length === 0 || ns.length > MAX_NAMESPACE_CHARS || !NAMESPACE_RE.test(ns)) {
    throw new BlobStoreError(
      'bad_namespace',
      `namespace ${preview(ns)} must match ${String(NAMESPACE_RE)} and be 1..${MAX_NAMESPACE_CHARS} chars`,
    );
  }
}

/**
 * Throws `BlobStoreError('bad_key')` unless `key` is a well-formed string (no lone surrogates) of
 * 1..MAX_KEY_BYTES UTF-8 bytes. `allowEmpty` admits `''` (list prefixes).
 */
export function validateKey(key: string, allowEmpty = false): void {
  if (typeof key !== 'string') {
    throw new BlobStoreError('bad_key', `key must be a string, got ${typeof key}`);
  }
  if (key.length === 0) {
    if (allowEmpty) return;
    throw new BlobStoreError('bad_key', 'key must not be empty');
  }
  // Every UTF-16 code unit of a well-formed string encodes to at least one UTF-8 byte, so an
  // over-long string is rejected without scanning it.
  const bytes = key.length > MAX_KEY_BYTES ? MAX_KEY_BYTES + 1 : wellFormedUtf8Length(key);
  if (bytes < 0) {
    throw new BlobStoreError('bad_key', `key ${preview(key)} contains a lone surrogate`);
  }
  if (bytes > MAX_KEY_BYTES) {
    throw new BlobStoreError(
      'bad_key',
      `key ${preview(key)} is longer than ${MAX_KEY_BYTES} UTF-8 bytes`,
    );
  }
}

/** Throws `BlobStoreError('bad_value')` unless `blob` is a Uint8Array of 0..MAX_BLOB_BYTES bytes. */
export function validateValue(blob: Uint8Array): void {
  if (!(blob instanceof Uint8Array)) {
    const kind = Object.prototype.toString.call(blob);
    throw new BlobStoreError('bad_value', `value must be a Uint8Array, got ${kind}`);
  }
  if (blob.byteLength > MAX_BLOB_BYTES) {
    throw new BlobStoreError(
      'bad_value',
      `value is ${blob.byteLength} bytes; the limit is ${MAX_BLOB_BYTES}`,
    );
  }
}

/**
 * Orders keys by Unicode code point, which equals UTF-8 byte order (SQLite's BINARY collation); a
 * proper prefix sorts first. Plain `<` compares UTF-16 code units, which puts supplementary
 * characters (surrogate pairs) before U+E000..U+FFFF.
 */
export function compareKeys(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const ua = a.charCodeAt(i);
    const ub = b.charCodeAt(i);
    if (ua !== ub) {
      // Everything before `i` is equal, so the first differing code points start at `i` (or, at a
      // low surrogate, share the high surrogate before it, and the low surrogates decide).
      const ca = a.codePointAt(i) ?? ua;
      const cb = b.codePointAt(i) ?? ub;
      return ca < cb ? -1 : 1;
    }
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

/**
 * The smallest string strictly greater than every string starting with `prefix`, or `null` when
 * there is none (`''`, or only U+10FFFF code points). Used as the exclusive upper bound of a
 * prefix range scan: `key >= prefix AND key < prefixUpperBound(prefix)`.
 */
export function prefixUpperBound(prefix: string): string | null {
  let end = prefix.length;
  while (end > 0) {
    // Last code point of prefix.slice(0, end), and where it starts.
    let start = end - 1;
    let last = prefix.charCodeAt(start);
    if (end >= 2 && isLowSurrogate(last)) {
      const pair = prefix.codePointAt(end - 2) ?? 0;
      if (pair > 0xffff) {
        start = end - 2;
        last = pair;
      }
    }
    if (last !== 0x10ffff) {
      let next = last + 1;
      if (next >= 0xd800 && next <= 0xdfff) next = 0xe000; // skip the surrogate range
      return prefix.slice(0, start) + String.fromCodePoint(next);
    }
    end = start; // U+10FFFF cannot be incremented: carry into the previous code point
  }
  return null;
}

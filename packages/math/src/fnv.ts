/** FNV-1a 32-bit offset basis. */
export const FNV_BASIS = 0x811c9dc5;
/** FNV-1a 32-bit prime. */
export const FNV_PRIME = 0x01000193;

/**
 * FNV-1a 32 over the bytes of `input`, starting from `seed` (default `FNV_BASIS`). Strings are hashed
 * over their UTF-8 encoding without allocating; lone surrogates encode as U+FFFD, exactly as
 * `TextEncoder` does, so a string and its UTF-8 bytes hash identically. Returns a u32.
 */
export function fnv1a32(input: string | Uint8Array, seed: number = FNV_BASIS): number {
  let h = seed >>> 0;
  if (typeof input !== 'string') {
    for (let i = 0; i < input.length; i++) {
      h = Math.imul(h ^ (input[i] as number), FNV_PRIME);
    }
    return h >>> 0;
  }
  const n = input.length;
  for (let i = 0; i < n; i++) {
    let c = input.charCodeAt(i);
    if (c < 0x80) {
      h = Math.imul(h ^ c, FNV_PRIME);
      continue;
    }
    if (c < 0x800) {
      h = Math.imul(h ^ (0xc0 | (c >> 6)), FNV_PRIME);
      h = Math.imul(h ^ (0x80 | (c & 0x3f)), FNV_PRIME);
      continue;
    }
    if (c >= 0xd800 && c <= 0xdfff) {
      const d = i + 1 < n ? input.charCodeAt(i + 1) : 0;
      if (c <= 0xdbff && d >= 0xdc00 && d <= 0xdfff) {
        const cp = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
        h = Math.imul(h ^ (0xf0 | (cp >> 18)), FNV_PRIME);
        h = Math.imul(h ^ (0x80 | ((cp >> 12) & 0x3f)), FNV_PRIME);
        h = Math.imul(h ^ (0x80 | ((cp >> 6) & 0x3f)), FNV_PRIME);
        h = Math.imul(h ^ (0x80 | (cp & 0x3f)), FNV_PRIME);
        continue;
      }
      c = 0xfffd; // lone surrogate
    }
    h = Math.imul(h ^ (0xe0 | (c >> 12)), FNV_PRIME);
    h = Math.imul(h ^ (0x80 | ((c >> 6) & 0x3f)), FNV_PRIME);
    h = Math.imul(h ^ (0x80 | (c & 0x3f)), FNV_PRIME);
  }
  return h >>> 0;
}

/** Mixes the 4 little-endian bytes of the u32 `value` into the running hash `h`. Returns a u32. */
export function fnv1a32u32(h: number, value: number): number {
  for (let i = 0; i < 4; i++) {
    h = Math.imul(h ^ ((value >>> (8 * i)) & 0xff), FNV_PRIME);
  }
  return h >>> 0;
}

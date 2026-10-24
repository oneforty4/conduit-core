const encoder = new TextEncoder();
// ignoreBOM keeps a leading U+FEFF in the output, so every string round-trips exactly.
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** UTF-8 bytes of `s`; lone surrogates become U+FFFD. */
export function utf8Encode(s: string): Uint8Array {
  return encoder.encode(s);
}

/** Decodes UTF-8 bytes. Throws a `TypeError` on invalid input (fatal decoder). */
export function utf8Decode(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

/** Byte length of the UTF-8 encoding of `s` (lone surrogates count as U+FFFD, 3 bytes). */
export function utf8Length(s: string): number {
  const n = s.length;
  let bytes = n;
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) continue;
    if (c < 0x800) {
      bytes += 1;
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < n) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        // surrogate pair: 2 code units -> 4 bytes
        bytes += 2;
        i++;
      } else {
        bytes += 2;
      }
    } else {
      bytes += 2; // BMP char or lone surrogate -> 3 bytes
    }
  }
  return bytes;
}

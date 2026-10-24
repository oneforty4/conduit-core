import { MAX_WRITER_BYTES } from './constants.ts';
import { DecodeError, EncodeError } from './errors.ts';
import { utf8Decode, utf8Encode, utf8Length } from './utf8.ts';

const GROWTH_STEP = 1024;

function varuintSize(v: number): number {
  return v < 0x80 ? 1 : v < 0x4000 ? 2 : v < 0x200000 ? 3 : v < 0x10000000 ? 4 : 5;
}

function rangeError(type: string, v: number): EncodeError {
  return new EncodeError('range', `${type}: ${String(v)} is not an integer in range`);
}

/**
 * Growable little-endian byte writer over one `ArrayBuffer` (docs/protocol.md 3). Integer writers
 * throw `EncodeError('range')` for values that are not integers in the type's range.
 */
export class ByteWriter {
  private buf: Uint8Array;
  private dv: DataView;
  private len = 0;

  constructor(initialCapacity = 1024) {
    if (
      !Number.isInteger(initialCapacity) ||
      initialCapacity < 0 ||
      initialCapacity > MAX_WRITER_BYTES
    ) {
      throw new RangeError(
        `ByteWriter: initialCapacity must be an integer in 0..${MAX_WRITER_BYTES}`,
      );
    }
    this.buf = new Uint8Array(initialCapacity);
    this.dv = new DataView(this.buf.buffer);
  }

  /** Bytes written so far. */
  get length(): number {
    return this.len;
  }

  private ensure(n: number): void {
    const need = this.len + n;
    if (need > this.buf.length) this.grow(need);
  }

  private grow(need: number): void {
    if (need > MAX_WRITER_BYTES) {
      throw new EncodeError('capacity', `ByteWriter: ${need} bytes exceeds MAX_WRITER_BYTES`);
    }
    let cap = Math.max(this.buf.length * 2, need);
    cap = Math.ceil(cap / GROWTH_STEP) * GROWTH_STEP;
    if (cap > MAX_WRITER_BYTES) cap = MAX_WRITER_BYTES;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
    this.dv = new DataView(next.buffer);
  }

  u8(v: number): void {
    if ((v & 0xff) !== v) throw rangeError('u8', v);
    this.ensure(1);
    this.buf[this.len++] = v;
  }

  i8(v: number): void {
    if ((v << 24) >> 24 !== v) throw rangeError('i8', v);
    this.ensure(1);
    this.buf[this.len++] = v & 0xff;
  }

  u16(v: number): void {
    if ((v & 0xffff) !== v) throw rangeError('u16', v);
    this.ensure(2);
    const o = this.len;
    this.buf[o] = v & 0xff;
    this.buf[o + 1] = v >>> 8;
    this.len = o + 2;
  }

  i16(v: number): void {
    if ((v << 16) >> 16 !== v) throw rangeError('i16', v);
    this.ensure(2);
    const o = this.len;
    this.buf[o] = v & 0xff;
    this.buf[o + 1] = (v >> 8) & 0xff;
    this.len = o + 2;
  }

  u32(v: number): void {
    if (v >>> 0 !== v) throw rangeError('u32', v);
    this.write32(v);
  }

  i32(v: number): void {
    if ((v | 0) !== v) throw rangeError('i32', v);
    this.write32(v);
  }

  private write32(v: number): void {
    this.ensure(4);
    const o = this.len;
    const b = this.buf;
    b[o] = v & 0xff;
    b[o + 1] = (v >>> 8) & 0xff;
    b[o + 2] = (v >>> 16) & 0xff;
    b[o + 3] = (v >>> 24) & 0xff;
    this.len = o + 4;
  }

  /** IEEE-754 binary32; accepts any number, including NaN and +-Infinity. */
  f32(v: number): void {
    this.ensure(4);
    this.dv.setFloat32(this.len, v, true);
    this.len += 4;
  }

  /** Unsigned LEB128 of an integer in `0..2^32-1`, 1 to 5 bytes. */
  varuint(v: number): void {
    if (v >>> 0 !== v) throw rangeError('varuint', v);
    this.ensure(varuintSize(v));
    const b = this.buf;
    let o = this.len;
    let x = v;
    while (x >= 0x80) {
      b[o++] = (x & 0x7f) | 0x80;
      x >>>= 7;
    }
    b[o++] = x;
    this.len = o;
  }

  /** Raw copy, no length prefix. */
  bytes(src: Uint8Array): void {
    this.ensure(src.length);
    this.buf.set(src, this.len);
    this.len += src.length;
  }

  /** `varuint byteLength` then the UTF-8 bytes; `EncodeError('length')` if `byteLength > max`. */
  utf8(s: string, max: number): void {
    const n = utf8Length(s);
    if (n > max) {
      throw new EncodeError('length', `string of ${n} UTF-8 bytes exceeds max ${max}`);
    }
    this.ensure(varuintSize(n) + n);
    this.varuint(n);
    const b = this.buf;
    const o = this.len;
    if (n === s.length) {
      for (let i = 0; i < n; i++) b[o + i] = s.charCodeAt(i); // ASCII
    } else {
      b.set(utf8Encode(s), o);
    }
    this.len = o + n;
  }

  /** Writes `0x00` and returns its offset. */
  reserveU8(): number {
    const o = this.len;
    this.u8(0);
    return o;
  }

  /** Writes `0x0000` and returns its offset. */
  reserveU16(): number {
    const o = this.len;
    this.u16(0);
    return o;
  }

  private checkPatch(offset: number, n: number): void {
    if (!Number.isInteger(offset) || offset < 0 || offset + n > this.len) {
      throw new EncodeError('range', `patch of ${n} bytes at ${offset} is outside 0..${this.len}`);
    }
  }

  patchU8(offset: number, v: number): void {
    this.checkPatch(offset, 1);
    if ((v & 0xff) !== v) throw rangeError('u8', v);
    this.buf[offset] = v;
  }

  patchU16(offset: number, v: number): void {
    this.checkPatch(offset, 2);
    if ((v & 0xffff) !== v) throw rangeError('u16', v);
    this.buf[offset] = v & 0xff;
    this.buf[offset + 1] = v >>> 8;
  }

  patchU32(offset: number, v: number): void {
    this.checkPatch(offset, 4);
    if (v >>> 0 !== v) throw rangeError('u32', v);
    this.dv.setUint32(offset, v, true);
  }

  /** Drops everything after `length`; `length` must be <= the current length. */
  truncate(length: number): void {
    if (!Number.isInteger(length) || length < 0 || length > this.len) {
      throw new EncodeError('range', `truncate(${length}) outside 0..${this.len}`);
    }
    this.len = length;
  }

  /** `[0, length)` over the internal buffer, no copy; invalid after the next write or reset. */
  view(): Uint8Array {
    return this.buf.subarray(0, this.len);
  }

  /** A fresh copy of `[0, length)`; the writer is then reset. */
  finish(): Uint8Array {
    const out = this.buf.slice(0, this.len);
    this.len = 0;
    return out;
  }

  /** `length = 0`; capacity is kept. */
  reset(): void {
    this.len = 0;
  }
}

const f32Bytes = new Uint8Array(4);
const f32View = new DataView(f32Bytes.buffer);

/**
 * Bounds-checked little-endian reader over `buf[offset, offset + length)` (docs/protocol.md 3).
 * Every failing read throws `DecodeError` with the offset of the value it was reading and leaves
 * `offset` unchanged.
 */
export class ByteReader {
  readonly buf: Uint8Array;
  /** Absolute index into `buf`. */
  offset: number;
  /** `offset + length` at construction. */
  readonly end: number;

  constructor(buf: Uint8Array, offset = 0, length = buf.byteLength - offset) {
    if (
      !Number.isInteger(offset) ||
      !Number.isInteger(length) ||
      offset < 0 ||
      length < 0 ||
      offset + length > buf.byteLength
    ) {
      throw new RangeError(`ByteReader: [${offset}, ${offset}+${length}) is outside the buffer`);
    }
    this.buf = buf;
    this.offset = offset;
    this.end = offset + length;
  }

  remaining(): number {
    return this.end - this.offset;
  }

  private take(n: number): number {
    const o = this.offset;
    if (o + n > this.end) throw new DecodeError('eof', o);
    this.offset = o + n;
    return o;
  }

  u8(): number {
    const o = this.take(1);
    return this.buf[o]!;
  }

  i8(): number {
    const o = this.take(1);
    return (this.buf[o]! << 24) >> 24;
  }

  u16(): number {
    const o = this.take(2);
    const b = this.buf;
    return b[o]! | (b[o + 1]! << 8);
  }

  i16(): number {
    const o = this.take(2);
    const b = this.buf;
    return ((b[o]! | (b[o + 1]! << 8)) << 16) >> 16;
  }

  u32(): number {
    const o = this.take(4);
    const b = this.buf;
    return (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
  }

  i32(): number {
    const o = this.take(4);
    const b = this.buf;
    return b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24);
  }

  f32(): number {
    const o = this.take(4);
    const b = this.buf;
    f32Bytes[0] = b[o]!;
    f32Bytes[1] = b[o + 1]!;
    f32Bytes[2] = b[o + 2]!;
    f32Bytes[3] = b[o + 3]!;
    return f32View.getFloat32(0, true);
  }

  /**
   * Unsigned LEB128, at most 5 bytes. `DecodeError('varuint')` if the 5th byte has bit 7 set or
   * carries bits above bit 31 (`byte5 > 0x0F`).
   */
  varuint(): number {
    const start = this.offset;
    const b = this.buf;
    const end = this.end;
    let o = start;
    let result = 0;
    for (let shift = 0; shift < 28; shift += 7) {
      if (o >= end) throw new DecodeError('eof', start);
      const byte = b[o++]!;
      result |= (byte & 0x7f) << shift;
      if (byte < 0x80) {
        this.offset = o;
        return result;
      }
    }
    if (o >= end) throw new DecodeError('eof', start);
    const byte = b[o++]!;
    if (byte > 0x0f) throw new DecodeError('varuint', start);
    this.offset = o;
    return (result | (byte << 28)) >>> 0;
  }

  private count(n: number): number {
    if (!Number.isInteger(n) || n < 0) throw new RangeError(`ByteReader: invalid byte count ${n}`);
    return this.take(n);
  }

  /** Subarray view of the next `n` bytes, no copy. */
  bytes(n: number): Uint8Array {
    const o = this.count(n);
    return this.buf.subarray(o, o + n);
  }

  /**
   * `varuint n` then `n` UTF-8 bytes. `DecodeError('length')` if `n > max`, `'eof'` if fewer than
   * `n` bytes remain, `'utf8'` for invalid UTF-8.
   */
  utf8(max: number): string {
    const start = this.offset;
    const n = this.varuint();
    if (n > max) {
      this.offset = start;
      throw new DecodeError('length', start, `string of ${n} bytes exceeds max ${max}`);
    }
    const o = this.offset;
    if (o + n > this.end) {
      this.offset = start;
      throw new DecodeError('eof', start);
    }
    let s: string;
    try {
      s = utf8Decode(this.buf.subarray(o, o + n));
    } catch {
      this.offset = start;
      throw new DecodeError('utf8', start);
    }
    this.offset = o + n;
    return s;
  }

  skip(n: number): void {
    this.count(n);
  }

  /** A reader over the next `n` bytes; advances this reader by `n`. */
  sub(n: number): ByteReader {
    const o = this.count(n);
    return new ByteReader(this.buf, o, n);
  }
}

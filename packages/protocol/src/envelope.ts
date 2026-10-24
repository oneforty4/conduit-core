import { ByteReader, ByteWriter } from './bytes.ts';
import {
  MAX_FRAME_BYTES,
  MAX_MESSAGES_PER_FRAME,
  MAX_PAYLOAD_BYTES,
  MESSAGE_HEADER_BYTES,
  SEQ_MODULO,
  WIRE_VERSION,
} from './constants.ts';
import { DecodeError, EncodeError } from './errors.ts';

export interface MessageHeader {
  kind: number;
  tick: number;
  seq: number;
  /** payloadLength */
  length: number;
}

/**
 * Assembles one frame: `u8 wireVersion | u8 messageCount | (u8 kind | u32 tick | u16 seq |
 * u16 payloadLength | payload) x messageCount` (docs/protocol.md 8).
 */
export class FrameWriter {
  private readonly w: ByteWriter;
  private n = 0;
  private countOffset = -1; // -1 while no frame is open

  constructor(writer?: ByteWriter) {
    this.w = writer ?? new ByteWriter(4096);
  }

  /** Messages in the open frame. */
  get count(): number {
    return this.n;
  }

  /** Starts a frame: resets the writer, writes wireVersion and reserves the count byte. */
  begin(): void {
    this.w.reset();
    this.w.u8(WIRE_VERSION);
    this.countOffset = this.w.reserveU8();
    this.n = 0;
  }

  /**
   * Appends one message. On any throw (from the header, `encodePayload`, or a payload longer than
   * `MAX_PAYLOAD_BYTES`, which throws `EncodeError('payload')`) the writer is truncated to before
   * the header and `count` is unchanged. A 256th message throws `EncodeError('count')`.
   */
  message(kind: number, tick: number, seq: number, encodePayload: (w: ByteWriter) => void): void {
    if (this.countOffset < 0) throw new Error('FrameWriter.message() called before begin()');
    if (this.n >= MAX_MESSAGES_PER_FRAME) {
      throw new EncodeError('count', `a frame holds at most ${MAX_MESSAGES_PER_FRAME} messages`);
    }
    const w = this.w;
    const start = w.length;
    try {
      w.u8(kind);
      w.u32(tick);
      w.u16(seq);
      const lengthOffset = w.reserveU16();
      const payloadStart = w.length;
      encodePayload(w);
      const length = w.length - payloadStart;
      if (length < 0) throw new Error('FrameWriter: encodePayload truncated the frame');
      if (length > MAX_PAYLOAD_BYTES) {
        throw new EncodeError('payload', `payload of ${length} bytes exceeds MAX_PAYLOAD_BYTES`);
      }
      w.patchU16(lengthOffset, length);
    } catch (err) {
      if (w.length >= start) w.truncate(start);
      else this.abort(); // earlier messages were damaged; the frame cannot be salvaged
      throw err;
    }
    this.n++;
  }

  /** Patches the count, returns a copy of the frame and resets. */
  finish(): Uint8Array {
    if (this.countOffset < 0) throw new Error('FrameWriter.finish() called before begin()');
    this.w.patchU8(this.countOffset, this.n);
    const out = this.w.finish();
    this.countOffset = -1;
    this.n = 0;
    return out;
  }

  /** Discards the partial frame. */
  abort(): void {
    this.w.reset();
    this.countOffset = -1;
    this.n = 0;
  }
}

/**
 * Parses a frame and calls `onMessage` once per message with a reader limited to its payload; the
 * next message is found by `payloadLength` whatever the callback consumed. The framing (size,
 * version, headers, payload lengths, no trailing bytes) is validated before any callback runs.
 */
export function readFrame(
  buf: Uint8Array,
  onMessage: (h: MessageHeader, payload: ByteReader) => void,
): void {
  if (buf.byteLength > MAX_FRAME_BYTES) {
    throw new DecodeError('length', 0, `frame of ${buf.byteLength} bytes exceeds MAX_FRAME_BYTES`);
  }
  const r = new ByteReader(buf);
  const version = r.u8();
  if (version !== WIRE_VERSION) {
    throw new DecodeError('version', 0, `wire version ${version}, expected ${WIRE_VERSION}`);
  }
  const count = r.u8();
  const bodyStart = r.offset;
  for (let i = 0; i < count; i++) {
    if (r.remaining() < MESSAGE_HEADER_BYTES) throw new DecodeError('eof', r.offset);
    r.skip(MESSAGE_HEADER_BYTES - 2);
    const lengthOffset = r.offset;
    const length = r.u16();
    if (length > r.remaining()) {
      throw new DecodeError('length', lengthOffset, `payloadLength ${length} > remaining bytes`);
    }
    r.skip(length);
  }
  if (r.remaining() !== 0) {
    throw new DecodeError(
      'length',
      r.offset,
      `${r.remaining()} trailing bytes after the last message`,
    );
  }
  r.offset = bodyStart;
  for (let i = 0; i < count; i++) {
    const kind = r.u8();
    const tick = r.u32();
    const seq = r.u16();
    const length = r.u16();
    onMessage({ kind, tick, seq, length }, r.sub(length));
  }
}

/** Serial-arithmetic "a is newer than b" over 16-bit sequence numbers. */
export function seqAfter(a: number, b: number): boolean {
  const d = (a - b) & 0xffff;
  return d !== 0 && d < 0x8000;
}

/** `(seq + 1) mod SEQ_MODULO`. */
export function nextSeq(seq: number): number {
  return (seq + 1) % SEQ_MODULO;
}

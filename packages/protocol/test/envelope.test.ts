import { describe, expect, it } from 'vitest';
import {
  ByteWriter,
  CoreKind,
  DecodeError,
  EncodeError,
  encodeWith,
  FRAME_HEADER_BYTES,
  FrameWriter,
  MAX_FRAME_BYTES,
  MAX_MESSAGES_PER_FRAME,
  MAX_PAYLOAD_BYTES,
  MESSAGE_HEADER_BYTES,
  nextSeq,
  PingSchema,
  readFrame,
  SEQ_MODULO,
  seqAfter,
  WIRE_VERSION,
  type ByteReader,
  type DecodeErrorCode,
  type EncodeErrorCode,
  type MessageHeader,
} from '../src/index.ts';

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
}

function fromHex(text: string): Uint8Array {
  const clean = text.replace(/\s+/g, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function decodeErr(fn: () => unknown): { code: DecodeErrorCode; offset: number } | 'none' {
  try {
    fn();
  } catch (err) {
    if (err instanceof DecodeError) return { code: err.code, offset: err.offset };
    throw err;
  }
  return 'none';
}

function encodeErr(fn: () => unknown): EncodeErrorCode | 'none' {
  try {
    fn();
  } catch (err) {
    if (err instanceof EncodeError) return err.code;
    throw err;
  }
  return 'none';
}

interface Seen {
  header: MessageHeader;
  payload: string;
}

function collect(buf: Uint8Array): Seen[] {
  const seen: Seen[] = [];
  readFrame(buf, (header, payload) => {
    seen.push({ header, payload: hex(payload.bytes(payload.remaining())) });
  });
  return seen;
}

describe('constants', () => {
  it('match the envelope layout', () => {
    expect(WIRE_VERSION).toBe(4);
    expect(FRAME_HEADER_BYTES).toBe(2);
    expect(MESSAGE_HEADER_BYTES).toBe(9);
    expect(MAX_MESSAGES_PER_FRAME).toBe(255);
    expect(MAX_PAYLOAD_BYTES).toBe(65535);
    expect(MAX_FRAME_BYTES).toBe(1048576);
    expect(SEQ_MODULO).toBe(65536);
  });
});

describe('FrameWriter', () => {
  it('writes the exact frame bytes', () => {
    const fw = new FrameWriter();
    fw.begin();
    fw.message(CoreKind.Ping, 0x01020304, 0xbeef, (w) =>
      encodeWith(w, PingSchema, { clientTimeMs: 0xaabbccdd }),
    );
    expect(fw.count).toBe(1);
    const frame = fw.finish();
    // 04 wireVersion | 01 count | 05 kind | 04 03 02 01 tick | ef be seq | 04 00 length | dd cc bb aa
    expect(hex(frame)).toBe('04 01 05 04 03 02 01 ef be 04 00 dd cc bb aa');
    expect(fw.count).toBe(0);
  });

  it('frames 0 messages as a 2-byte keepalive', () => {
    const fw = new FrameWriter();
    fw.begin();
    const frame = fw.finish();
    expect(hex(frame)).toBe('04 00');
    expect(collect(frame)).toEqual([]);
  });

  it('frames an empty payload with payloadLength 0', () => {
    const fw = new FrameWriter();
    fw.begin();
    fw.message(CoreKind.Ready, 0, 0, () => {});
    expect(hex(fw.finish())).toBe('04 01 02 00 00 00 00 00 00 00 00');
  });

  it('frames 255 messages and rejects the 256th without changing count', () => {
    const fw = new FrameWriter(new ByteWriter(16));
    fw.begin();
    for (let i = 0; i < 255; i++) fw.message(128 + (i % 128), i * 1000, i, (w) => w.u8(i));
    expect(fw.count).toBe(255);
    expect(encodeErr(() => fw.message(128, 0, 255, (w) => w.u8(0)))).toBe('count');
    expect(fw.count).toBe(255);
    const frame = fw.finish();
    expect(frame.length).toBe(2 + 255 * (9 + 1));
    expect(frame[1]).toBe(0xff);
    const seen = collect(frame);
    expect(seen).toHaveLength(255);
    seen.forEach((s, i) => {
      expect(s.header).toEqual({ kind: 128 + (i % 128), tick: i * 1000, seq: i, length: 1 });
      expect(s.payload).toBe(i.toString(16).padStart(2, '0'));
    });
  });

  it('rolls back a message whose encoder throws, leaving count unchanged', () => {
    const fw = new FrameWriter();
    fw.begin();
    fw.message(5, 1, 1, (w) => w.u32(7));
    const boom = new Error('boom');
    expect(() =>
      fw.message(6, 2, 2, (w) => {
        w.u32(0xffffffff);
        w.u8(1);
        throw boom;
      }),
    ).toThrow(boom);
    expect(fw.count).toBe(1);
    // a failing field encoder mid-payload
    expect(
      encodeErr(() => fw.message(6, 2, 2, (w) => encodeWith(w, PingSchema, { clientTimeMs: -1 }))),
    ).toBe('range');
    expect(fw.count).toBe(1);
    fw.message(7, 3, 3, () => {});
    expect(hex(fw.finish())).toBe(
      '04 02 05 01 00 00 00 01 00 04 00 07 00 00 00 07 03 00 00 00 03 00 00 00',
    );
  });

  it('throws payload for a payload over MAX_PAYLOAD_BYTES and rolls back', () => {
    const fw = new FrameWriter();
    fw.begin();
    expect(
      encodeErr(() => fw.message(130, 0, 0, (w) => w.bytes(new Uint8Array(MAX_PAYLOAD_BYTES + 1)))),
    ).toBe('payload');
    expect(fw.count).toBe(0);
    fw.message(130, 0, 0, (w) => w.bytes(new Uint8Array(MAX_PAYLOAD_BYTES)));
    const frame = fw.finish();
    expect(frame.length).toBe(2 + 9 + MAX_PAYLOAD_BYTES);
    expect(hex(frame.subarray(0, 11))).toBe('04 01 82 00 00 00 00 00 00 ff ff');
  });

  it('rejects out-of-range header fields and rolls back', () => {
    const fw = new FrameWriter();
    fw.begin();
    expect(encodeErr(() => fw.message(256, 0, 0, () => {}))).toBe('range');
    expect(encodeErr(() => fw.message(1, 2 ** 32, 0, () => {}))).toBe('range');
    expect(encodeErr(() => fw.message(1, 0, 65536, () => {}))).toBe('range');
    expect(encodeErr(() => fw.message(1, -1, 0, () => {}))).toBe('range');
    expect(fw.count).toBe(0);
    expect(hex(fw.finish())).toBe('04 00');
  });

  it('requires begin() and supports abort()', () => {
    const fw = new FrameWriter();
    expect(() => fw.message(1, 0, 0, () => {})).toThrow(Error);
    expect(() => fw.finish()).toThrow(Error);
    fw.begin();
    fw.message(1, 0, 0, (w) => w.u8(1));
    fw.abort();
    expect(fw.count).toBe(0);
    expect(() => fw.finish()).toThrow(Error);
    fw.begin();
    fw.begin(); // begin resets any partial frame
    fw.message(2, 0, 0, () => {});
    expect(hex(fw.finish())).toBe('04 01 02 00 00 00 00 00 00 00 00');
  });

  it('returns an independent copy from finish()', () => {
    const fw = new FrameWriter();
    fw.begin();
    fw.message(1, 0, 0, (w) => w.u8(0xaa));
    const first = fw.finish();
    fw.begin();
    fw.message(1, 0, 0, (w) => w.u8(0xbb));
    fw.finish();
    expect(hex(first)).toBe('04 01 01 00 00 00 00 00 00 01 00 aa');
    expect(first.byteOffset).toBe(0);
    expect(first.buffer.byteLength).toBe(first.length);
  });
});

describe('readFrame', () => {
  it('parses headers and limits each payload reader', () => {
    // 04 02 | c8 ff ff ff ff ff ff 01 00 | 7f | 05 07 00 00 00 01 00 04 00 | 2a 00 00 00
    const frame = fromHex(
      '04 02 c8 ff ff ff ff ff ff 01 00 7f 05 07 00 00 00 01 00 04 00 2a 00 00 00',
    );
    const seen: { header: MessageHeader; start: number; end: number }[] = [];
    readFrame(frame, (header, payload) => {
      seen.push({ header, start: payload.offset, end: payload.end });
    });
    expect(seen).toEqual([
      { header: { kind: 200, tick: 0xffffffff, seq: 0xffff, length: 1 }, start: 11, end: 12 },
      { header: { kind: 5, tick: 7, seq: 1, length: 4 }, start: 21, end: 25 },
    ]);
    expect(seen[0]?.header).not.toBe(seen[1]?.header);
  });

  it('skips an unknown kind by payloadLength and still delivers the following message', () => {
    // unknown kind 200 with a 3-byte payload the callback never reads, then Ping{clientTimeMs: 42}
    const frame = fromHex(
      '04 02 c8 00 00 00 00 00 00 03 00 01 02 03 05 07 00 00 00 01 00 04 00 2a 00 00 00',
    );
    const delivered: number[] = [];
    readFrame(frame, (h, payload) => {
      if (h.kind !== CoreKind.Ping) return; // unknown: skipped
      delivered.push(PingSchema.decode(payload).clientTimeMs);
    });
    expect(delivered).toEqual([42]);
  });

  it('advances by payloadLength whatever the callback consumed', () => {
    const fw = new FrameWriter();
    fw.begin();
    fw.message(1, 0, 0, (w) => w.u32(0x11111111));
    fw.message(2, 0, 1, (w) => w.u32(0x22222222));
    const values: number[] = [];
    readFrame(fw.finish(), (h, payload) => {
      if (h.kind === 1)
        payload.u8(); // partial read
      else values.push(payload.u32());
    });
    expect(values).toEqual([0x22222222]);
  });

  it('gives each payload reader an eof at the payload boundary', () => {
    const frame = fromHex('04 02 05 00 00 00 00 00 00 01 00 aa 06 00 00 00 00 00 00 01 00 bb');
    const errors: unknown[] = [];
    readFrame(frame, (_h, payload) => {
      payload.u8();
      errors.push(decodeErr(() => payload.u8()));
    });
    expect(errors).toEqual([
      { code: 'eof', offset: 12 },
      { code: 'eof', offset: 22 },
    ]);
  });

  it('throws length for a truncated payload before running any callback', () => {
    // a valid first message, then payloadLength 4 (at offset 18) with only 2 bytes left
    const frame = fromHex('04 02 05 00 00 00 00 00 00 00 00 05 00 00 00 00 00 00 04 00 01 02');
    let calls = 0;
    expect(decodeErr(() => readFrame(frame, () => calls++))).toEqual({
      code: 'length',
      offset: 18,
    });
    expect(calls).toBe(0);
    expect(
      decodeErr(() => readFrame(fromHex('04 01 05 00 00 00 00 00 00 04 00 01 02'), () => {})),
    ).toEqual({
      code: 'length',
      offset: 9,
    });
  });

  it('throws version for a wrong wire version', () => {
    expect(decodeErr(() => readFrame(fromHex('03 00'), () => {}))).toEqual({
      code: 'version',
      offset: 0,
    });
    expect(decodeErr(() => readFrame(fromHex('02 00'), () => {}))).toEqual({
      code: 'version',
      offset: 0,
    });
    expect(decodeErr(() => readFrame(fromHex('01 00'), () => {}))).toEqual({
      code: 'version',
      offset: 0,
    });
    expect(decodeErr(() => readFrame(fromHex('00 01 05'), () => {}))).toEqual({
      code: 'version',
      offset: 0,
    });
  });

  it('throws eof for an empty buffer or a truncated header', () => {
    expect(decodeErr(() => readFrame(new Uint8Array(0), () => {}))).toEqual({
      code: 'eof',
      offset: 0,
    });
    expect(decodeErr(() => readFrame(fromHex('04'), () => {}))).toEqual({ code: 'eof', offset: 1 });
    expect(decodeErr(() => readFrame(fromHex('04 01 05 00 00'), () => {}))).toEqual({
      code: 'eof',
      offset: 2,
    });
  });

  it('throws length for trailing bytes after the last message', () => {
    expect(decodeErr(() => readFrame(fromHex('04 00 ff'), () => {}))).toEqual({
      code: 'length',
      offset: 2,
    });
  });

  it('throws length for a frame longer than MAX_FRAME_BYTES, before parsing', () => {
    const big = new Uint8Array(MAX_FRAME_BYTES + 1);
    big[0] = 99; // would be a version error if parsed
    expect(decodeErr(() => readFrame(big, () => {}))).toEqual({ code: 'length', offset: 0 });
  });

  it('accepts a frame of exactly MAX_FRAME_BYTES', () => {
    const fw = new FrameWriter();
    fw.begin();
    const full = MESSAGE_HEADER_BYTES + MAX_PAYLOAD_BYTES; // 65544
    for (let i = 0; i < 15; i++)
      fw.message(129, 0, i, (w) => w.bytes(new Uint8Array(MAX_PAYLOAD_BYTES)));
    const lastPayload = MAX_FRAME_BYTES - FRAME_HEADER_BYTES - 15 * full - MESSAGE_HEADER_BYTES;
    fw.message(129, 0, 15, (w) => w.bytes(new Uint8Array(lastPayload)));
    const frame = fw.finish();
    expect(frame.length).toBe(MAX_FRAME_BYTES);
    let n = 0;
    readFrame(frame, (_h: MessageHeader, _p: ByteReader) => n++);
    expect(n).toBe(16);
  });
});

describe('sequence numbers', () => {
  it('seqAfter uses 16-bit serial arithmetic across the wrap', () => {
    expect(seqAfter(0, 65535)).toBe(true);
    expect(seqAfter(65535, 0)).toBe(false);
    expect(seqAfter(1, 65535)).toBe(true);
    expect(seqAfter(65535, 65534)).toBe(true);
    expect(seqAfter(5, 5)).toBe(false);
    expect(seqAfter(0x7fff, 0)).toBe(true);
    expect(seqAfter(0x8000, 0)).toBe(false); // exactly half the space apart: neither is after
    expect(seqAfter(0, 0x8000)).toBe(false);
    expect(seqAfter(0x8000, 1)).toBe(true);
    expect(seqAfter(1, 0x8000)).toBe(false);
  });

  it('nextSeq wraps modulo SEQ_MODULO', () => {
    expect(nextSeq(0)).toBe(1);
    expect(nextSeq(65534)).toBe(65535);
    expect(nextSeq(65535)).toBe(0);
    let s = 65530;
    for (let i = 0; i < 12; i++) {
      const n = nextSeq(s);
      expect(seqAfter(n, s)).toBe(true);
      expect(seqAfter(s, n)).toBe(false);
      s = n;
    }
    expect(s).toBe(6);
  });
});

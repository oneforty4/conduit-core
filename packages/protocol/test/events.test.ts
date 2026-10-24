import { describe, expect, it } from 'vitest';
import {
  ByteReader,
  ByteWriter,
  DecodeError,
  decodeEvents,
  defineEvent,
  defineInput,
  EncodeError,
  encodeEvents,
  f,
  REGION_IDX_NONE,
  SchemaRegistry,
  type DecodeErrorCode,
  type EncodeErrorCode,
  type EventsData,
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

// Sorted by name: Boom = 0, Chat = 1, Local = 2 (not replicated)
const registry = new SchemaRegistry({
  components: [],
  messages: [],
  events: [
    defineEvent('Local', { n: f.u8 }),
    defineEvent('Chat', { text: f.str(16) }, { replicate: true }),
    defineEvent('Boom', { power: f.u8 }, { replicate: true }),
  ],
  input: defineInput({ tick: f.u32 }),
});

const data: EventsData = {
  regions: ['a', 'b'],
  events: [
    { eventId: 0, tick: 10, regionIdx: 0, payload: { power: 7 } },
    { eventId: 1, tick: 10, regionIdx: 1, payload: { text: 'yo' } },
    { eventId: 0, tick: 11, regionIdx: REGION_IDX_NONE, payload: { power: 1 } },
  ],
};

// Hand-derived from docs/protocol.md 9.12; offsets in the left column.
const FIXTURE = [
  '02', //                    0 regionCount
  '01 61', //                 1 'a'
  '01 62', //                 3 'b'
  '03 00', //                 5 eventCount 3
  '00 0a 00 00 00 00 07', //  7 Boom | tick 10 | region 0 | power 7
  '01 0a 00 00 00 01 02 79 6f', // 14 Chat | tick 10 | region 1 | 'yo'
  '00 0b 00 00 00 ff 01', // 23 Boom | tick 11 | REGION_IDX_NONE | power 1
].join(' ');

function patched(offset: number, value: number): Uint8Array {
  const bytes = fromHex(FIXTURE);
  bytes[offset] = value;
  return bytes;
}

describe('Events codec', () => {
  it('round-trips two events in two regions and one global event, byte-exact', () => {
    const w = new ByteWriter();
    encodeEvents(w, registry, data);
    expect(hex(w.view())).toBe(FIXTURE);
    const r = new ByteReader(w.view());
    expect(decodeEvents(r, registry)).toEqual(data);
    expect(r.remaining()).toBe(0);
  });

  it('encodes an empty batch as 3 bytes', () => {
    const w = new ByteWriter();
    encodeEvents(w, registry, { regions: [], events: [] });
    expect(hex(w.view())).toBe('00 00 00');
    expect(decodeEvents(new ByteReader(w.view()), registry)).toEqual({ regions: [], events: [] });
  });

  it('rejects a non-replicated or unknown event id with unknown', () => {
    expect(decodeErr(() => decodeEvents(new ByteReader(patched(7, 2)), registry))).toEqual({
      code: 'unknown',
      offset: 7,
    }); // Local
    expect(decodeErr(() => decodeEvents(new ByteReader(patched(14, 9)), registry))).toEqual({
      code: 'unknown',
      offset: 14,
    });
  });

  it('rejects a bad regionIdx with range', () => {
    expect(decodeErr(() => decodeEvents(new ByteReader(patched(12, 2)), registry))).toEqual({
      code: 'range',
      offset: 12,
    });
  });

  it('reports payload errors and truncation', () => {
    expect(decodeErr(() => decodeEvents(new ByteReader(patched(20, 17)), registry))).toEqual({
      code: 'length',
      offset: 20,
    }); // 'yo' length 17 > str(16)
    const bytes = fromHex(FIXTURE);
    expect(decodeErr(() => decodeEvents(new ByteReader(bytes.subarray(0, 29)), registry))).toEqual({
      code: 'eof',
      offset: 29,
    });
  });

  it('refuses to encode non-replicated events or bad region indices, rolling back', () => {
    const w = new ByteWriter();
    const local = {
      regions: [],
      events: [{ eventId: 2, tick: 1, regionIdx: REGION_IDX_NONE, payload: { n: 1 } }],
    };
    expect(encodeErr(() => encodeEvents(w, registry, local))).toBe('range');
    const region = {
      regions: ['a'],
      events: [{ eventId: 0, tick: 1, regionIdx: 1, payload: { power: 1 } }],
    };
    expect(encodeErr(() => encodeEvents(w, registry, region))).toBe('range');
    const payload = {
      regions: [],
      events: [
        { eventId: 1, tick: 1, regionIdx: REGION_IDX_NONE, payload: { text: 'x'.repeat(17) } },
      ],
    };
    expect(encodeErr(() => encodeEvents(w, registry, payload))).toBe('length');
    expect(w.length).toBe(0);
  });
});

import { describe, expect, it } from 'vitest';
import {
  ByteReader,
  ByteWriter,
  DecodeError,
  decodeSnapshot,
  defineInput,
  defineSchema,
  EncodeError,
  encodeSnapshot,
  f,
  MAX_REGION_TABLE,
  readSnapshotHeader,
  REGION_IDX_NONE,
  SchemaRegistry,
  SNAPSHOT_FLAG_FULL,
  SNAPSHOT_FLAG_MASKED,
  SNAPSHOT_FLAG_STATE_TICKS,
  writeSnapshotHeader,
  type ComponentLike,
  type DecodeErrorCode,
  type EncodeErrorCode,
  type FieldType,
  type SnapshotComponent,
  type SnapshotData,
  type SnapshotHeader,
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

function component(name: string, schema: ComponentLike['schema'], replicate = true): ComponentLike {
  return { name, schema, replicate, interpolate: [] };
}

// Sorted by name: Hp = 0, Pos = 1, Secret = 2 (not replicated), Tag = 3
const registry = new SchemaRegistry({
  components: [
    component('Tag', defineSchema({ label: f.str(8) })),
    component('Secret', defineSchema({ v: f.u8 }), false),
    component('Pos', defineSchema({ x: f.i16, y: f.i16 })),
    component('Hp', defineSchema({ hp: f.u8 })),
  ],
  messages: [],
  events: [],
  input: defineInput({ tick: f.u32 }),
});

const header: SnapshotHeader = {
  serverTick: 300,
  serverTimeMs: 5000,
  baselineTick: 297,
  lastInputSeq: 42,
  lastInputTick: 299,
  flags: 0,
};

const data: SnapshotData = {
  header,
  regions: ['r0', 'r1'],
  creates: [
    {
      entity: 5,
      regionIdx: 1,
      components: [
        { id: 0, value: { hp: 100 } },
        { id: 1, value: { x: -2, y: 300 } },
      ],
    },
  ],
  updates: [{ entity: 3, components: [{ id: 3, value: { label: 'hi' } }], removed: [1] }],
  destroys: [9],
};

// Hand-derived from docs/protocol.md 9.11; offsets in the left column.
const FIXTURE = [
  '2c 01 00 00', //  0 serverTick 300 = 0x12C
  '88 13 00 00', //  4 serverTimeMs 5000 = 0x1388
  '29 01 00 00', //  8 baselineTick 297 = 0x129
  '2a 00', //       12 lastInputSeq 42
  '2b 01 00 00', // 14 lastInputTick 299 = 0x12B
  '00', //          18 flags
  '02', //          19 regionCount
  '02 72 30', //    20 'r0'
  '02 72 31', //    23 'r1'
  '01 00', //       26 createCount 1
  '04', //          28 entity 5: the gap from ENTITY_NONE, less 1
  '01', //          29 regionIdx 1
  '02', //          30 compCount 2
  '00 64', //       31 compId 0 (Hp) | hp 100
  '01 fe ff 2c 01', // 33 compId 1 (Pos) | x -2 | y 300
  '01 00', //       38 updateCount 1
  '02', //          40 entity 3 (each list starts from ENTITY_NONE)
  '01', //          41 compCount 1
  '03 02 68 69', // 42 compId 3 (Tag) | label 'hi'
  '01', //          46 removedCount 1
  '01', //          47 removed compId 1 (Pos)
  '01 00', //       48 destroyCount 1
  '08', //          50 entity 9
].join(' ');

function patched(offset: number, value: number): Uint8Array {
  const bytes = fromHex(FIXTURE);
  bytes[offset] = value;
  return bytes;
}

/** `count` u8 fields named `<prefix>0`, `<prefix>1`, ... */
function u8Fields(prefix: string, count: number): Record<string, FieldType<number>> {
  return Object.fromEntries(Array.from({ length: count }, (_, i) => [`${prefix}${i}`, f.u8]));
}

/** `{ <prefix>0: first, <prefix>1: first + 1, ... }` */
function numbered(prefix: string, count: number, first: number): Record<string, number> {
  return Object.fromEntries(Array.from({ length: count }, (_, i) => [`${prefix}${i}`, first + i]));
}

// Field masks (docs/protocol.md 9.11.1). Sorted by name: Body = 0 (3 fields, u8 mask), Flag = 1 (no
// fields, u8 mask), Grid = 2 (12 fields, u16 mask; g8 is a u16), Huge = 3 (17 fields, never masked)
const maskedRegistry = new SchemaRegistry({
  components: [
    component('Huge', defineSchema(u8Fields('h', 17))),
    component('Grid', defineSchema({ ...u8Fields('g', 12), g8: f.u16 })),
    component('Flag', defineSchema({})),
    component('Body', defineSchema({ hp: f.u8, pos: f.vec2(f.i16), label: f.str(8) })),
  ],
  messages: [],
  events: [],
  input: defineInput({ tick: f.u32 }),
});

const maskedHeader: SnapshotHeader = { ...header, flags: SNAPSHOT_FLAG_MASKED };

const maskedData: SnapshotData = {
  header: maskedHeader,
  regions: ['r0'],
  creates: [
    {
      entity: 5,
      regionIdx: 0,
      components: [{ id: 0, value: { hp: 100, pos: { x: -2, y: 300 }, label: 'hi' } }],
    },
  ],
  updates: [
    {
      entity: 3,
      components: [
        { id: 0, value: { hp: 7, label: 'ok' }, mask: 0b101 },
        { id: 1, value: {}, mask: 0 },
        { id: 3, value: numbered('h', 17, 0) },
      ],
      removed: [],
    },
    {
      entity: 4,
      components: [
        { id: 0, value: {}, mask: 0 },
        { id: 2, value: { g0: 9, g8: 0x1234, g11: 255 }, mask: 0x0901 },
      ],
      removed: [1],
    },
  ],
  destroys: [9],
};

/** The FIXTURE header up to its flags byte (offsets 0-17). */
const HEADER_HEX = '2c 01 00 00 88 13 00 00 29 01 00 00 2a 00 2b 01 00 00';

// Hand-derived from docs/protocol.md 9.11 and 9.11.1; offsets in the left column.
const MASKED_FIXTURE = [
  HEADER_HEX, //    0 serverTick 300 | serverTimeMs 5000 | baselineTick 297 | seq 42 | inputTick 299
  '02', //          18 flags MASKED
  '01', //          19 regionCount 1
  '02 72 30', //    20 'r0'
  '01 00', //       23 createCount 1
  '04', //          25 entity 5
  '00', //          26 regionIdx 0
  '01', //          27 compCount 1
  '00 64 fe ff 2c 01 02 68 69', // 28 compId 0 (Body), a create: no mask | hp 100 | pos -2, 300 | 'hi'
  '02 00', //       37 updateCount 2
  '02', //          39 entity 3
  '03', //          40 compCount 3
  '00 05 07 02 6f 6b', // 41 compId 0 (Body) | u8 mask 0b101 (hp, label) | hp 7 | label 'ok'
  '01 00', //       47 compId 1 (Flag, no fields) | u8 mask 0
  '03 00 01 02 03 04 05 06 07 08 09 0a 0b 0c 0d 0e 0f 10', // 49 compId 3 (Huge): no mask | h0-h16
  '00', //          67 removedCount 0
  '00', //          68 entity 4: 3 + 1 + 0
  '02', //          69 compCount 2
  '00 00', //       70 compId 0 (Body) | u8 mask 0: no field bytes
  '02 01 09 09 34 12 ff', // 72 compId 2 (Grid) | u16 mask 0x0901 (g0, g8, g11) | 9 | 0x1234 | 255
  '01', //          79 removedCount 1
  '01', //          80 removed compId 1 (Flag)
  '01 00', //       81 destroyCount 1
  '08', //          83 entity 9
].join(' ');

function patchedMasked(offset: number, value: number): Uint8Array {
  const bytes = fromHex(MASKED_FIXTURE);
  bytes[offset] = value;
  return bytes;
}

describe('Snapshot codec', () => {
  it('matches the byte-exact fixture', () => {
    const w = new ByteWriter();
    encodeSnapshot(w, registry, data);
    expect(hex(w.view())).toBe(FIXTURE);
    expect(w.length).toBe(51);
  });

  it('round-trips through a registry', () => {
    const r = new ByteReader(fromHex(FIXTURE));
    const decoded = decodeSnapshot(r, registry);
    expect(r.remaining()).toBe(0);
    expect(decoded).toEqual(data);
    const w = new ByteWriter();
    encodeSnapshot(w, registry, decoded);
    expect(hex(w.view())).toBe(FIXTURE);
  });

  it('decodes fresh component values each time', () => {
    const a = decodeSnapshot(new ByteReader(fromHex(FIXTURE)), registry);
    const b = decodeSnapshot(new ByteReader(fromHex(FIXTURE)), registry);
    expect(a.creates[0]?.components[0]?.value).not.toBe(b.creates[0]?.components[0]?.value);
  });

  it('an empty snapshot is 19 + 1 + 2 + 2 + 2 bytes', () => {
    const w = new ByteWriter();
    const empty: SnapshotData = {
      header: {
        serverTick: 1,
        serverTimeMs: 2,
        baselineTick: 0,
        lastInputSeq: 0,
        lastInputTick: 0,
        flags: SNAPSHOT_FLAG_FULL,
      },
      regions: [],
      creates: [],
      updates: [],
      destroys: [],
    };
    encodeSnapshot(w, registry, empty);
    expect(w.length).toBe(19 + 1 + 2 + 2 + 2);
    expect(hex(w.view())).toBe(
      '01 00 00 00 02 00 00 00 00 00 00 00 00 00 00 00 00 00 01 00 00 00 00 00 00 00',
    );
    expect(decodeSnapshot(new ByteReader(w.view()), registry)).toEqual(empty);
  });

  it('accepts REGION_IDX_NONE for a create without a region', () => {
    expect(REGION_IDX_NONE).toBe(255);
    const decoded = decodeSnapshot(new ByteReader(patched(29, 0xff)), registry);
    expect(decoded.creates[0]?.regionIdx).toBe(REGION_IDX_NONE);
  });

  it('rejects a compId that is not a replicated component with unknown', () => {
    expect(decodeErr(() => decodeSnapshot(new ByteReader(patched(31, 2)), registry))).toEqual({
      code: 'unknown',
      offset: 31,
    }); // Secret is not replicated
    expect(decodeErr(() => decodeSnapshot(new ByteReader(patched(33, 9)), registry))).toEqual({
      code: 'unknown',
      offset: 33,
    }); // no component 9
    expect(decodeErr(() => decodeSnapshot(new ByteReader(patched(42, 4)), registry))).toEqual({
      code: 'unknown',
      offset: 42,
    });
    expect(decodeErr(() => decodeSnapshot(new ByteReader(patched(47, 2)), registry))).toEqual({
      code: 'unknown',
      offset: 47,
    }); // removed id
  });

  it('rejects a bad regionIdx with range', () => {
    expect(decodeErr(() => decodeSnapshot(new ByteReader(patched(29, 2)), registry))).toEqual({
      code: 'range',
      offset: 29,
    }); // regionCount is 2
    expect(decodeErr(() => decodeSnapshot(new ByteReader(patched(29, 254)), registry))).toEqual({
      code: 'range',
      offset: 29,
    });
  });

  it('reports component schema errors and truncation', () => {
    // Tag label length 9 > str(8) max
    expect(decodeErr(() => decodeSnapshot(new ByteReader(patched(43, 9)), registry))).toEqual({
      code: 'length',
      offset: 43,
    });
    const bytes = fromHex(FIXTURE);
    expect(
      decodeErr(() => decodeSnapshot(new ByteReader(bytes.subarray(0, 50)), registry)),
    ).toEqual({
      code: 'eof',
      offset: 50,
    });
    expect(
      decodeErr(() => decodeSnapshot(new ByteReader(bytes.subarray(0, 10)), registry)),
    ).toEqual({
      code: 'eof',
      offset: 8,
    });
  });

  it('rejects unencodable data and rolls the writer back', () => {
    const w = new ByteWriter();
    w.u8(0xee);
    const bad = (patch: Partial<SnapshotData>): SnapshotData => ({ ...data, ...patch });
    expect(
      encodeErr(() =>
        encodeSnapshot(
          w,
          registry,
          bad({ creates: [{ entity: 1, regionIdx: 0, components: [{ id: 2, value: { v: 1 } }] }] }),
        ),
      ),
    ).toBe('range');
    expect(
      encodeErr(() =>
        encodeSnapshot(
          w,
          registry,
          bad({ creates: [{ entity: 1, regionIdx: 2, components: [] }] }),
        ),
      ),
    ).toBe('range');
    expect(
      encodeErr(() =>
        encodeSnapshot(
          w,
          registry,
          bad({ updates: [{ entity: 1, components: [], removed: [7] }] }),
        ),
      ),
    ).toBe('range');
    expect(
      encodeErr(() =>
        encodeSnapshot(
          w,
          registry,
          bad({ regions: Array.from({ length: MAX_REGION_TABLE + 1 }, (_, i) => `r${i}`) }),
        ),
      ),
    ).toBe('count');
    expect(
      encodeErr(() => encodeSnapshot(w, registry, bad({ header: { ...header, flags: 8 } }))),
    ).toBe('range');
    expect(
      encodeErr(() =>
        encodeSnapshot(
          w,
          registry,
          bad({
            creates: [{ entity: 1, regionIdx: 0, components: [{ id: 0, value: { hp: 256 } }] }],
          }),
        ),
      ),
    ).toBe('range');
    expect(w.length).toBe(1);
    const table = Array.from({ length: MAX_REGION_TABLE }, (_, i) => `r${i}`);
    expect(
      encodeErr(() =>
        encodeSnapshot(
          w,
          registry,
          bad({ regions: table, creates: [{ entity: 1, regionIdx: 254, components: [] }] }),
        ),
      ),
    ).toBe('none');
  });

  it('writes each entity as its gap from the one before, so ids must strictly ascend', () => {
    const at = (entity: number) => ({ entity, regionIdx: REGION_IDX_NONE, components: [] });
    // Generation 3 of slot 2 (docs/sim.md 2.1) after slot 1: one large gap, then small ones.
    const gen3 = (3 << 20) | 2;
    const s: SnapshotData = {
      header: { ...header, flags: 0 },
      regions: [],
      creates: [at(1), at(2), at(130), at(gen3)],
      updates: [],
      destroys: [0xffffffff],
    };
    const w = new ByteWriter();
    encodeSnapshot(w, registry, s);
    expect(hex(w.view().subarray(19))).toBe(
      [
        '00 04 00', // regionCount 0 | createCount 4
        '00 ff 00', // entity 1 | REGION_IDX_NONE | compCount 0
        '00 ff 00', // entity 2: gap 0
        '7f ff 00', // entity 130: 2 + 1 + 127
        'ff fe bf 01 ff 00', // entity 0x300002: 130 + 1 + 3145599 (3-byte varuint)
        '00 00 01 00', // updateCount 0 | destroyCount 1
        'fe ff ff ff 0f', // entity 0xffffffff: the widest gap, 5 bytes
      ].join(' '),
    );
    expect(decodeSnapshot(new ByteReader(w.view()), registry)).toEqual(s);
    w.reset();
    w.u8(0xee);
    for (const creates of [[at(0)], [at(2), at(2)], [at(3), at(2)], [at(1.5)], [at(2 ** 32)]])
      expect(encodeErr(() => encodeSnapshot(w, registry, { ...s, creates }))).toBe('range');
    for (const destroys of [[0], [9, 9], [9, 3]])
      expect(encodeErr(() => encodeSnapshot(w, registry, { ...s, destroys }))).toBe('range');
    expect(w.length).toBe(1);
    // A gap past 2^32 - 1 in any list: 0xffffffff, then one more.
    const beyond = fromHex(`${hex(fromHex(FIXTURE).subarray(0, 48))} 02 00 fe ff ff ff 0f 00`);
    expect(decodeErr(() => decodeSnapshot(new ByteReader(beyond), registry))).toEqual({
      code: 'range',
      offset: 55,
    });
  });

  it('writes STATE_TICKS stamps as their age, serverTick - stateTick', () => {
    const s: SnapshotData = {
      header: { ...header, flags: SNAPSHOT_FLAG_STATE_TICKS },
      regions: [],
      creates: [{ entity: 4, stateTick: 300, regionIdx: REGION_IDX_NONE, components: [] }],
      updates: [
        { entity: 2, stateTick: 172, components: [], removed: [] },
        { entity: 3, stateTick: 0, components: [], removed: [] },
      ],
      destroys: [],
    };
    const w = new ByteWriter();
    encodeSnapshot(w, registry, s);
    expect(hex(w.view().subarray(19))).toBe(
      [
        '00 01 00', // regionCount 0 | createCount 1
        '03 00 ff 00', // entity 4 | age 0 | REGION_IDX_NONE | compCount 0
        '02 00', // updateCount 2
        '01 80 01 00 00', // entity 2 | age 128 (2-byte varuint) | compCount 0 | removedCount 0
        '00 ac 02 00 00', // entity 3 | age 300: tick 0
        '00 00', // destroyCount 0
      ].join(' '),
    );
    expect(decodeSnapshot(new ByteReader(w.view()), registry)).toEqual(s);
    // An age above serverTick would put the stamp before tick 0.
    const bytes = new Uint8Array(w.view());
    bytes[34] = 0xad; // entity 3's age: 301
    expect(decodeErr(() => decodeSnapshot(new ByteReader(bytes), registry))).toEqual({
      code: 'range',
      offset: 34,
    });
    for (const stateTick of [301, -1, 1.5]) {
      const later = { ...s, creates: [{ ...s.creates[0]!, stateTick }] };
      expect(encodeErr(() => encodeSnapshot(new ByteWriter(), registry, later))).toBe('range');
    }
  });
});

describe('Snapshot field masks', () => {
  it('encodes a MASKED snapshot byte-exactly with u8 and u16 masks', () => {
    expect(SNAPSHOT_FLAG_MASKED).toBe(0x02);
    expect(maskedRegistry.component(2)?.schema.fieldNames[8]).toBe('g8');
    const w = new ByteWriter();
    encodeSnapshot(w, maskedRegistry, maskedData);
    expect(hex(w.view())).toBe(MASKED_FIXTURE);
    expect(w.length).toBe(84);
  });

  it('decodes a masked record to its mask and exactly the flagged fields', () => {
    const r = new ByteReader(fromHex(MASKED_FIXTURE));
    const decoded = decodeSnapshot(r, maskedRegistry);
    expect(r.remaining()).toBe(0);
    expect(decoded).toStrictEqual(maskedData);
    const body = decoded.updates[0]?.components[0];
    expect(body).toStrictEqual({ id: 0, value: { hp: 7, label: 'ok' }, mask: 0b101 });
    expect(Object.keys(body?.value as object)).toEqual(['hp', 'label']); // pos absent, not undefined
    const grid = decoded.updates[1]?.components[1];
    expect(Object.keys(grid?.value as object)).toEqual(['g0', 'g8', 'g11']);
    // records that carried no mask on the wire have no mask key: the create and the 17-field Huge
    expect(decoded.creates[0]?.components[0]).not.toHaveProperty('mask');
    expect(decoded.updates[0]?.components[2]).not.toHaveProperty('mask');
    const w = new ByteWriter();
    encodeSnapshot(w, maskedRegistry, decoded);
    expect(hex(w.view())).toBe(MASKED_FIXTURE);
  });

  it('a mask of zero carries no field bytes', () => {
    const decoded = decodeSnapshot(new ByteReader(fromHex(MASKED_FIXTURE)), maskedRegistry);
    expect(decoded.updates[0]?.components[1]).toStrictEqual({ id: 1, value: {}, mask: 0 }); // Flag
    expect(decoded.updates[1]?.components[0]).toStrictEqual({ id: 0, value: {}, mask: 0 }); // Body

    const zero: SnapshotData = {
      header: maskedHeader,
      regions: [],
      creates: [],
      updates: [
        {
          entity: 1,
          components: [
            { id: 0, value: {}, mask: 0 },
            { id: 2, value: {}, mask: 0 },
          ],
          removed: [],
        },
      ],
      destroys: [],
    };
    const w = new ByteWriter();
    encodeSnapshot(w, maskedRegistry, zero);
    expect(hex(w.view())).toBe(
      [
        HEADER_HEX, //    0
        '02', //          18 flags MASKED
        '00 00 00', //    19 regionCount 0 | createCount 0
        '01 00', //       22 updateCount 1
        '00', //          24 entity 1
        '02', //          25 compCount 2
        '00 00', //       26 compId 0 (Body) | u8 mask 0
        '02 00 00', //    28 compId 2 (Grid) | u16 mask 0
        '00 00 00', //    31 removedCount 0 | destroyCount 0
      ].join(' '),
    );
    expect(w.length).toBe(34);
    expect(decodeSnapshot(new ByteReader(w.view()), maskedRegistry)).toStrictEqual(zero);
  });

  it('keeps creates whole in a MASKED snapshot', () => {
    // offsets 19-36 (region table and the create) are the same bytes with the flag off
    const unmasked = new ByteWriter();
    encodeSnapshot(unmasked, maskedRegistry, { ...maskedData, header, updates: [], destroys: [] });
    expect(hex(unmasked.view().subarray(19, 37))).toBe(
      hex(fromHex(MASKED_FIXTURE).subarray(19, 37)),
    );

    const w = new ByteWriter();
    const value = { hp: 1, pos: { x: 0, y: 0 }, label: '' };
    expect(
      encodeErr(() =>
        encodeSnapshot(w, maskedRegistry, {
          ...maskedData,
          creates: [{ entity: 5, regionIdx: 0, components: [{ id: 0, value, mask: 0b111 }] }],
        }),
      ),
    ).toBe('range');
    expect(w.length).toBe(0);
  });

  it('rejects unknown mask bits at the mask offset, and on encode', () => {
    const at = (offset: number, value: number): ReturnType<typeof decodeErr> =>
      decodeErr(() => decodeSnapshot(new ByteReader(patchedMasked(offset, value)), maskedRegistry));
    expect(at(42, 0x08)).toEqual({ code: 'range', offset: 42 }); // Body has 3 fields: bit 3
    expect(at(42, 0x87)).toEqual({ code: 'range', offset: 42 });
    expect(at(48, 0x01)).toEqual({ code: 'range', offset: 48 }); // Flag has none: only 0
    expect(at(74, 0x19)).toEqual({ code: 'range', offset: 73 }); // Grid has 12: bit 12 of the u16
    expect(at(74, 0x89)).toEqual({ code: 'range', offset: 73 }); // bit 15
    const truncated = fromHex(MASKED_FIXTURE).subarray(0, 74); // half of Grid's u16 mask
    expect(decodeErr(() => decodeSnapshot(new ByteReader(truncated), maskedRegistry))).toEqual({
      code: 'eof',
      offset: 73,
    });

    const w = new ByteWriter();
    w.u8(0xee);
    const bad: SnapshotComponent[] = [
      { id: 0, value: { hp: 7 }, mask: 0b1000 },
      { id: 0, value: { hp: 7 }, mask: 0x87 },
      { id: 1, value: {}, mask: 1 },
      { id: 2, value: { g0: 9 }, mask: 0x1001 },
      { id: 0, value: { hp: 7 }, mask: -1 },
      { id: 0, value: { hp: 7 }, mask: 0.5 },
      { id: 0, value: { hp: 7 }, mask: Number.NaN },
    ];
    for (const c of bad) {
      const s: SnapshotData = {
        ...maskedData,
        updates: [{ entity: 3, components: [c], removed: [] }],
      };
      expect(encodeErr(() => encodeSnapshot(w, maskedRegistry, s))).toBe('range');
    }
    expect(w.length).toBe(1);
  });

  it('allows a mask only on update components of a MASKED snapshot with at most 16 fields', () => {
    const w = new ByteWriter();
    const update = (c: SnapshotComponent): SnapshotData['updates'] => [
      { entity: 3, components: [c], removed: [] },
    ];
    const huge = { id: 3, value: numbered('h', 17, 0), mask: 1 };
    expect(
      encodeErr(() => encodeSnapshot(w, maskedRegistry, { ...maskedData, updates: update(huge) })),
    ).toBe('range');
    const body = { id: 0, value: { hp: 7 }, mask: 1 };
    expect(
      encodeErr(() =>
        encodeSnapshot(w, maskedRegistry, { ...maskedData, header, updates: update(body) }),
      ),
    ).toBe('range');
    const tag = { id: 3, value: { label: 'hi' }, mask: 1 };
    expect(encodeErr(() => encodeSnapshot(w, registry, { ...data, updates: update(tag) }))).toBe(
      'range',
    );
    expect(w.length).toBe(0);

    // `mask: undefined` is no mask
    const updates = [{ entity: 3, components: [{ ...tag, mask: undefined }], removed: [1] }];
    encodeSnapshot(w, registry, { ...data, updates });
    expect(hex(w.view())).toBe(FIXTURE);
  });

  it('leaves unmasked snapshots unchanged, and puts full masks before whole records when MASKED', () => {
    const bodyWhole = { hp: 7, pos: { x: 1, y: 2 }, label: 'ok' };
    const gridWhole = numbered('g', 12, 1);
    const whole: SnapshotData = {
      header,
      regions: [],
      creates: [],
      updates: [
        {
          entity: 3,
          components: [
            { id: 0, value: bodyWhole },
            { id: 2, value: gridWhole },
          ],
          removed: [],
        },
      ],
      destroys: [],
    };
    const UNMASKED = [
      HEADER_HEX, //                                  0
      '00', //                                        18 flags 0
      '00 00 00 01 00', //                            19 regionCount 0 | createCount 0 | updateCount 1
      '02 02', //                                     24 entity 3 | compCount 2
      '00 07 01 00 02 00 02 6f 6b', //                26 Body: hp 7 | pos 1, 2 | label 'ok'
      '02 01 02 03 04 05 06 07 08 09 00 0a 0b 0c', // 35 Grid: g0-g7 1-8 | g8 9 (u16) | g9-g11 10-12
      '00 00 00', //                                  49 removedCount 0 | destroyCount 0
    ].join(' ');
    const w = new ByteWriter();
    encodeSnapshot(w, maskedRegistry, whole);
    expect(hex(w.view())).toBe(UNMASKED);
    const decoded = decodeSnapshot(new ByteReader(w.finish()), maskedRegistry);
    expect(decoded).toStrictEqual(whole); // no mask keys
    encodeSnapshot(w, maskedRegistry, decoded);
    expect(hex(w.view())).toBe(UNMASKED);

    // FIXTURE (encoded byte-identically above) decodes without mask keys too
    const original = decodeSnapshot(new ByteReader(fromHex(FIXTURE)), registry);
    for (const record of [...original.creates, ...original.updates]) {
      for (const c of record.components) expect(c).not.toHaveProperty('mask');
    }

    // the same data with MASKED: the same records, each behind a mask with every field bit set
    const MASKED = [
      HEADER_HEX, //                                        0
      '02', //                                              18 flags MASKED
      '00 00 00 01 00', //                                  19
      '02 02', //                                           24
      '00 07 07 01 00 02 00 02 6f 6b', //                   26 Body | u8 mask 0b111 | fields
      '02 ff 0f 01 02 03 04 05 06 07 08 09 00 0a 0b 0c', // 36 Grid | u16 mask 0x0fff | fields
      '00 00 00', //                                        52
    ].join(' ');
    w.reset();
    encodeSnapshot(w, maskedRegistry, { ...whole, header: maskedHeader });
    expect(hex(w.view())).toBe(MASKED);
    const masked = decodeSnapshot(new ByteReader(w.view()), maskedRegistry);
    expect(masked.updates[0]?.components).toStrictEqual([
      { id: 0, value: bodyWhole, mask: 0b111 },
      { id: 2, value: gridWhole, mask: 0x0fff },
    ]);
  });
});

describe('snapshot header', () => {
  it('is 19 bytes in the documented order', () => {
    const w = new ByteWriter();
    writeSnapshotHeader(w, {
      serverTick: 0x01020304,
      serverTimeMs: 0x05060708,
      baselineTick: 0x090a0b0c,
      lastInputSeq: 0x0d0e,
      lastInputTick: 0x0f101112,
      flags: 1,
    });
    expect(hex(w.view())).toBe('04 03 02 01 08 07 06 05 0c 0b 0a 09 0e 0d 12 11 10 0f 01');
    const out: SnapshotHeader = {
      serverTick: 0,
      serverTimeMs: 0,
      baselineTick: 0,
      lastInputSeq: 0,
      lastInputTick: 0,
      flags: 0,
    };
    const r = new ByteReader(w.view());
    expect(readSnapshotHeader(r, out)).toBe(out);
    expect(out).toEqual({
      serverTick: 0x01020304,
      serverTimeMs: 0x05060708,
      baselineTick: 0x090a0b0c,
      lastInputSeq: 0x0d0e,
      lastInputTick: 0x0f101112,
      flags: 1,
    });
    expect(r.remaining()).toBe(0);
  });

  it('preserves legacy payloads when unknown flag bits are present', () => {
    const decoded = decodeSnapshot(new ByteReader(patched(18, 0xf8)), registry);
    expect(decoded.header.flags).toBe(0);
    expect(decoded).toStrictEqual(data);
    const full = decodeSnapshot(new ByteReader(patched(18, 0xf9)), registry);
    expect(full.header.flags).toBe(SNAPSHOT_FLAG_FULL);
    const masked = decodeSnapshot(new ByteReader(patchedMasked(18, 0xfa)), maskedRegistry);
    expect(masked.header.flags).toBe(SNAPSHOT_FLAG_MASKED);
    expect(masked).toStrictEqual(maskedData);
    const both = decodeSnapshot(new ByteReader(patchedMasked(18, 0xfb)), maskedRegistry);
    expect(both.header.flags).toBe(SNAPSHOT_FLAG_FULL | SNAPSHOT_FLAG_MASKED);
  });

  it('accepts defined header flags and rejects unknown bits on encode', () => {
    const w = new ByteWriter();
    expect(encodeErr(() => writeSnapshotHeader(w, { ...header, flags: 0x80 }))).toBe('range');
    expect(encodeErr(() => writeSnapshotHeader(w, { ...header, flags: 0x08 }))).toBe('range');
    expect(encodeErr(() => writeSnapshotHeader(w, { ...header, lastInputTick: -1 }))).toBe('range');
    expect(w.length).toBe(0);
    writeSnapshotHeader(w, {
      ...header,
      flags: SNAPSHOT_FLAG_FULL | SNAPSHOT_FLAG_MASKED | SNAPSHOT_FLAG_STATE_TICKS,
    });
    expect(hex(w.view())).toBe(`${HEADER_HEX} 07`);
  });
});

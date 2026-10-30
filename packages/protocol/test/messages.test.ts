import { describe, expect, it } from 'vitest';
import {
  AckSchema,
  ByteReader,
  ByteWriter,
  CORE_MESSAGES,
  CoreKind,
  decodeWith,
  defineInput,
  EncodeError,
  encodeWith,
  f,
  FrameWriter,
  HelloSchema,
  defineSchema,
  INPUT_FLAG_GAPS,
  INPUT_FRAMES_PER_MESSAGE,
  inputMessageSchema,
  KickedSchema,
  KickReason,
  LeaveSchema,
  PingSchema,
  PlayerEntrySchema,
  PlayerState,
  PongSchema,
  ReadySchema,
  REGION_ID_MAX,
  REGION_LIST_MAX,
  RegionLoadStateSchema,
  RegionSetSchema,
  RejectedSchema,
  RejectReason,
  SessionStateSchema,
  SpawnedSchema,
  WelcomeSchema,
  type HelloPayload,
  type InputPayload,
  type Schema,
  type SessionStatePayload,
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

/** Encodes `value` and checks the bytes, then decodes the hex fixture and checks the value. */
function fixture<T>(schema: Schema<T>, value: T, expectedHex: string): void {
  const w = new ByteWriter();
  encodeWith(w, schema, value);
  expect(hex(w.view())).toBe(expectedHex);
  const r = new ByteReader(fromHex(expectedHex));
  expect(decodeWith(r, schema)).toEqual(value);
  expect(r.remaining()).toBe(0);
}

describe('kinds', () => {
  it('CoreKind has the documented values', () => {
    expect(CoreKind).toEqual({
      Hello: 1,
      Ready: 2,
      Input: 3,
      Ack: 4,
      Ping: 5,
      RegionLoadState: 6,
      Leave: 7,
      Welcome: 32,
      SessionState: 33,
      Spawned: 34,
      Snapshot: 35,
      Events: 36,
      Pong: 37,
      RegionSet: 38,
      Rejected: 39,
      Kicked: 40,
      SnapshotPart: 41,
    });
  });

  it('CORE_MESSAGES lists every core message in kind order with core: true', () => {
    const rows = CORE_MESSAGES.map((m) => [
      CoreKind[m.name as keyof typeof CoreKind],
      m.name,
      m.direction,
      m.core,
    ]);
    expect(rows).toEqual([
      [1, 'Hello', 'c2s', true],
      [2, 'Ready', 'c2s', true],
      [3, 'Input', 'c2s', true],
      [4, 'Ack', 'c2s', true],
      [5, 'Ping', 'c2s', true],
      [6, 'RegionLoadState', 'c2s', true],
      [7, 'Leave', 'c2s', true],
      [32, 'Welcome', 's2c', true],
      [33, 'SessionState', 's2c', true],
      [34, 'Spawned', 's2c', true],
      [35, 'Snapshot', 's2c', true],
      [36, 'Events', 's2c', true],
      [37, 'Pong', 's2c', true],
      [38, 'RegionSet', 's2c', true],
      [39, 'Rejected', 's2c', true],
      [40, 'Kicked', 's2c', true],
      [41, 'SnapshotPart', 's2c', true],
    ]);
    const byName = new Map(CORE_MESSAGES.map((m) => [m.name, m.schema]));
    expect(byName.get('Hello')).toBe(HelloSchema);
    expect(byName.get('Kicked')).toBe(KickedSchema);
    expect(byName.get('Snapshot')?.descriptor).toBe('struct{}'); // hand-coded, placeholder schema
    expect(byName.get('Events')?.descriptor).toBe('struct{}');
    expect(byName.get('Input')?.descriptor).toBe(
      'struct{firstTick:u32,frames:array(struct{tick:u32},4)}',
    );
    expect(Object.isFrozen(CORE_MESSAGES)).toBe(true);
  });

  it('reason and state enums', () => {
    expect(RejectReason).toEqual({
      SchemaMismatch: 0,
      BadToken: 1,
      SessionFull: 2,
      SessionNotRunning: 3,
      ProtocolVersion: 4,
      Compatibility: 5,
      Capacity: 6,
    });
    expect(PlayerState).toEqual({ Joined: 0, Ready: 1, Playing: 2, Away: 3 });
    expect(KickReason).toEqual({
      ServerShutdown: 0,
      AckTimeout: 1,
      Replaced: 2,
      Protocol: 3,
      Idle: 4,
      ByHost: 5,
    });
    expect(REGION_ID_MAX).toBe(64);
    expect(REGION_LIST_MAX).toBe(255);
    expect(INPUT_FRAMES_PER_MESSAGE).toBe(4);
  });
});

describe('byte-exact fixtures', () => {
  it('Hello', () => {
    const hello: HelloPayload = {
      protocolVersion: 1,
      registryHash: 0xdeadbeef,
      sessionToken: 'tok',
      reconnectToken: '',
      displayName: 'Zo\u{EB}',
    };
    fixture(
      HelloSchema,
      hello,
      [
        '00', // absent capacity selects the eight-player migration default
        '00', // absent snapshot limits select protocol defaults
        '00', // absent compatibility means schema-only
        '01 00', // protocolVersion u16 = 1
        'ef be ad de', // registryHash u32 = 0xDEADBEEF
        '03 74 6f 6b', // sessionToken 'tok'
        '00', // reconnectToken ''
        '04 5a 6f c3 ab', // displayName 'Zo\u{EB}': U+00EB is c3 ab in UTF-8
      ].join(' '),
    );
  });

  it('Hello with a 300-byte token uses a 2-byte varuint length', () => {
    const w = new ByteWriter();
    encodeWith(w, HelloSchema, {
      protocolVersion: 0xffff,
      registryHash: 0,
      sessionToken: 'a'.repeat(300),
      reconnectToken: 'r',
      displayName: '',
    });
    const bytes = w.view();
    // ff ff | 00 00 00 00 | ac 02 (300 = 0x12C -> 0x2c|0x80, 0x02) | 61 x 300 | 01 72 | 00
    expect(hex(bytes.subarray(0, 11))).toBe('00 00 00 ff ff 00 00 00 00 ac 02');
    expect(hex(bytes.subarray(311))).toBe('01 72 00');
    expect(bytes.length).toBe(314);
    expect(() =>
      encodeWith(new ByteWriter(), HelloSchema, {
        protocolVersion: 1,
        registryHash: 0,
        sessionToken: 'a'.repeat(2049),
        reconnectToken: '',
        displayName: '',
      }),
    ).toThrow(EncodeError);
  });

  it('Welcome', () => {
    fixture(
      WelcomeSchema,
      {
        playerId: 2,
        reconnectToken: 'rt',
        simTickRate: 60,
        snapshotEvery: 3,
        serverTick: 1000,
        serverTimeMs: 123456,
        worldSeed: 0x01020304,
      },
      [
        '00', // absent capacity selects the eight-player migration default
        '00', // absent snapshot limits select protocol defaults
        '00', // absent compatibility means schema-only
        '02', // playerId
        '02 72 74', // reconnectToken 'rt'
        '3c', // simTickRate 60
        '03', // snapshotEvery 3
        'e8 03 00 00', // serverTick 1000 = 0x3E8
        '40 e2 01 00', // serverTimeMs 123456 = 0x1E240
        '04 03 02 01', // worldSeed 0x01020304
      ].join(' '),
    );
  });

  it('Rejected (and an unknown reason still decodes)', () => {
    fixture(
      RejectedSchema,
      { reason: RejectReason.SessionFull, detail: 'full' },
      '02 04 66 75 6c 6c',
    );
    expect(decodeWith(new ByteReader(fromHex('09 00')), RejectedSchema)).toEqual({
      reason: 9,
      detail: '',
    });
  });

  it('SessionState', () => {
    const state: SessionStatePayload = {
      players: [
        { playerId: 0, name: 'A', state: PlayerState.Playing, entity: 0x00100001 },
        { playerId: 1, name: 'Bo', state: PlayerState.Joined, entity: 0 },
      ],
    };
    fixture(
      SessionStateSchema,
      state,
      [
        '02 00', // players count u16 = 2
        '00 01 41 02 01 00 10 00', // playerId 0, name 'A', state 2, entity 0x00100001
        '01 02 42 6f 00 00 00 00 00', // playerId 1, name 'Bo', state 0, entity ENTITY_NONE
      ].join(' '),
    );
    expect(PlayerEntrySchema.descriptor).toBe(
      'struct{playerId:u8,name:str(32),state:u8,entity:entity}',
    );
    const sixteen = {
      players: Array.from({ length: 16 }, (_, playerId) => ({
        ...PlayerEntrySchema.create(),
        playerId,
      })),
    };
    const writer = new ByteWriter();
    encodeWith(writer, SessionStateSchema, sixteen);
    expect(decodeWith(new ByteReader(writer.view()), SessionStateSchema)).toEqual(sixteen);
    const seventeen = {
      players: [...sixteen.players, { ...PlayerEntrySchema.create(), playerId: 16 }],
    };
    expect(() => encodeWith(new ByteWriter(), SessionStateSchema, seventeen)).toThrow(EncodeError);
  });

  it('Ready and Leave are empty', () => {
    fixture(ReadySchema, {}, '');
    fixture(LeaveSchema, {}, '');
    const fw = new FrameWriter();
    fw.begin();
    fw.message(CoreKind.Leave, 0, 3, (w) => encodeWith(w, LeaveSchema, {}));
    // 05 01 | 07 kind | 00 00 00 00 tick | 03 00 seq | 00 00 payloadLength
    expect(hex(fw.finish())).toBe('05 01 07 00 00 00 00 03 00 00 00');
  });

  it('Spawned', () => {
    fixture(
      SpawnedSchema,
      { playerId: 3, entity: 0x00200005, regionId: 'r0' },
      '03 05 00 20 00 02 72 30', // playerId 3 | entity LE | 'r0'
    );
  });

  it('Ack, Ping, Pong', () => {
    fixture(AckSchema, { lastSnapshotTick: 0x12345678 }, '78 56 34 12');
    fixture(PingSchema, { clientTimeMs: 4294967295 }, 'ff ff ff ff');
    fixture(
      PongSchema,
      { clientTimeMs: 1, serverTimeMs: 256, serverTick: 65536 },
      '01 00 00 00 00 01 00 00 00 00 01 00',
    );
  });

  it('RegionSet and RegionLoadState', () => {
    fixture(RegionSetSchema, { active: ['a', 'b'], prefetch: [] }, '02 00 01 61 01 62 00 00');
    fixture(
      RegionLoadStateSchema,
      { loaded: ['g0_0'], loading: ['g1_0', 'g2_0'] },
      [
        '01 00 04 67 30 5f 30', // loaded: ['g0_0']
        '02 00 04 67 31 5f 30 04 67 32 5f 30', // loading: ['g1_0', 'g2_0']
      ].join(' '),
    );
    expect(() =>
      encodeWith(new ByteWriter(), RegionSetSchema, { active: ['x'.repeat(65)], prefetch: [] }),
    ).toThrow(EncodeError);
  });

  it('Kicked', () => {
    fixture(KickedSchema, { reason: KickReason.ByHost }, '05');
  });

  it('a Rejected frame as the gateway sends it', () => {
    const fw = new FrameWriter();
    fw.begin();
    fw.message(CoreKind.Rejected, 0, 0, (w) =>
      encodeWith(w, RejectedSchema, { reason: RejectReason.ProtocolVersion, detail: 'full' }),
    );
    // 05 01 | 27 (39) | 00 00 00 00 | 00 00 | 06 00 | 04 04 66 75 6c 6c
    expect(hex(fw.finish())).toBe('05 01 27 00 00 00 00 00 00 06 00 04 04 66 75 6c 6c');
  });
});

describe('inputMessageSchema', () => {
  const SampleInput = defineInput({ tick: f.u32, move: f.vec2(f.fixed16(0.01)), fire: f.bool });
  const InputMessage = inputMessageSchema(SampleInput);

  it('wraps the input frame schema', () => {
    expect(InputMessage.fieldNames).toEqual(['firstTick', 'frames']);
    expect(InputMessage.descriptor).toBe(
      'struct{firstTick:u32,frames:array(struct{tick:u32,move:vec2(fixed16(0.01)),fire:bool},4)}',
    );
  });

  it('encodes u32 firstTick | u8 count | frames without their ticks', () => {
    const msg: InputPayload<ReturnType<typeof SampleInput.create>> = {
      firstTick: 100,
      frames: [
        { tick: 100, move: { x: 1, y: -0.5 }, fire: true },
        { tick: 101, move: { x: 0, y: 0 }, fire: false },
      ],
    };
    fixture(
      InputMessage,
      msg,
      [
        '64 00 00 00', // firstTick 100
        '02', // count 2, no gaps: ticks 100, 101
        '64 00 ce ff 01', // move (100, -50) as fixed16(0.01) | fire
        '00 00 00 00 00', // move (0, 0) | no fire
      ].join(' '),
    );
  });

  it('writes a gap before each later frame when the ticks do not follow on', () => {
    const at = (tick: number, fire: boolean) => ({ tick, move: { x: 0, y: 0 }, fire });
    fixture(
      InputMessage,
      { firstTick: 7, frames: [at(7, false), at(8, true), at(10, false), at(140, true)] },
      [
        '07 00 00 00', // firstTick 7
        '84', // count 4 | INPUT_FLAG_GAPS
        '00 00 00 00 00', // tick 7
        '00 00 00 00 00 01', // gap 0: tick 8
        '01 00 00 00 00 00', // gap 1: tick 10
        '81 01 00 00 00 00 01', // gap 129 (varuint): tick 140
      ].join(' '),
    );
    expect(INPUT_FLAG_GAPS).toBe(0x80);
    fixture(InputMessage, { firstTick: 9, frames: [] }, '09 00 00 00 00');
  });

  it('decodes into the frames it is given, and rejects counts, ticks and flags it cannot be', () => {
    const msg = {
      firstTick: 5,
      frames: [
        { tick: 5, move: { x: 1, y: 1 }, fire: true },
        { tick: 7, move: { x: 2, y: 2 }, fire: false },
      ],
    };
    const w = new ByteWriter();
    encodeWith(w, InputMessage, msg);
    const target = InputMessage.create();
    const kept = SampleInput.create();
    target.frames.push(kept, SampleInput.create(), SampleInput.create());
    InputMessage.decodeInto(new ByteReader(w.view()), target);
    expect(target).toEqual(msg);
    expect(target.frames[0]).toBe(kept); // reused, two of three
    const decode = (text: string) => () => decodeWith(new ByteReader(fromHex(text)), InputMessage);
    expect(decode('00 00 00 00 05')).toThrow(expect.objectContaining({ code: 'count', offset: 4 }));
    // 0xfffffffe, then a frame at 0xffffffff, then one beyond u32.
    expect(decode('fe ff ff ff 03 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00')).toThrow(
      expect.objectContaining({ code: 'range', offset: 15 }),
    );
    expect(decode('00 00 00 00 01 00 00 00')).toThrow(expect.objectContaining({ code: 'eof' }));
  });

  it('rejects frames that do not start at firstTick and ascend', () => {
    const at = (tick: number) => ({ tick, move: { x: 0, y: 0 }, fire: false });
    for (const frames of [[at(4)], [at(6)], [at(5), at(5)], [at(5), at(4)], [at(5), at(5.5)]]) {
      const w = new ByteWriter();
      w.u8(0xaa);
      expect(() => encodeWith(w, InputMessage, { firstTick: 5, frames })).toThrow(
        expect.objectContaining({ code: 'range' }),
      );
      expect(w.length).toBe(1); // rolled back
    }
  });

  it('allows at most INPUT_FRAMES_PER_MESSAGE frames', () => {
    const at = (tick: number) => ({ ...SampleInput.create(), tick });
    const five = { firstTick: 1, frames: [at(1), at(2), at(3), at(4), at(5)] };
    expect(() => encodeWith(new ByteWriter(), InputMessage, five)).toThrow(EncodeError);
    const four = { firstTick: 1, frames: [at(1), at(2), at(3), at(4)] };
    expect(() => encodeWith(new ByteWriter(), InputMessage, four)).not.toThrow();
  });

  it('needs a schema that begins with tick: f.u32', () => {
    expect(() => inputMessageSchema(defineSchema({ fire: f.bool }) as never)).toThrow(RangeError);
  });
});

import type { ByteReader, ByteWriter } from './bytes.ts';
import { CompatibilityField, type CompatibilityDescriptor } from './compatibility.ts';
import { PROTOCOL_SESSION_CAPACITY_MAX } from './constants.ts';
import { DecodeError, EncodeError } from './errors.ts';
import { f, type FieldType } from './fields.ts';
import { fnv1a32 } from './hash.ts';
import type { InputFrameBase, MessageDef, MessageDirection } from './registry.ts';
import { defineSchema, encodeWith, type Schema } from './schema.ts';
import { SnapshotLimitsField, type SnapshotLimits } from './snapshot-fragment.ts';

type PayloadOf<S> = S extends Schema<infer T> ? T : never;

/** Core message kinds (docs/protocol.md 9). Game messages use kinds 128..255. */
export const CoreKind = Object.freeze({
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
} as const);
export type CoreKind = (typeof CoreKind)[keyof typeof CoreKind];

// 9.1 Hello (c2s)
const helloSchema = defineSchema({
  maxSessionCapacity: f.optional(f.u8),
  snapshotLimits: f.optional(SnapshotLimitsField),
  compatibility: f.optional(CompatibilityField),
  protocolVersion: f.u16, // game.protocolVersion from defineGame (not WIRE_VERSION)
  registryHash: f.u32, // SchemaRegistry.hash
  sessionToken: f.str(2048),
  reconnectToken: f.str(64), // '' for a fresh join
  displayName: f.str(32),
});
export type HelloPayload = Omit<
  PayloadOf<typeof helloSchema>,
  'compatibility' | 'snapshotLimits' | 'maxSessionCapacity'
> & {
  maxSessionCapacity?: number | undefined;
  snapshotLimits?: SnapshotLimits | undefined;
  compatibility?: CompatibilityDescriptor | undefined;
};
export const HelloSchema: Schema<HelloPayload> = helloSchema;

// 9.2 Welcome (s2c)
const welcomeSchema = defineSchema({
  sessionCapacity: f.optional(f.u8),
  snapshotLimits: f.optional(SnapshotLimitsField),
  compatibility: f.optional(CompatibilityField),
  playerId: f.u8,
  reconnectToken: f.str(64),
  simTickRate: f.u8,
  snapshotEvery: f.u8,
  serverTick: f.u32,
  serverTimeMs: f.u32,
  worldSeed: f.u32,
});
export type WelcomePayload = Omit<
  PayloadOf<typeof welcomeSchema>,
  'compatibility' | 'snapshotLimits' | 'sessionCapacity'
> & {
  sessionCapacity?: number | undefined;
  snapshotLimits?: SnapshotLimits | undefined;
  compatibility?: CompatibilityDescriptor | undefined;
};
export const WelcomeSchema: Schema<WelcomePayload> = welcomeSchema;

// 9.3 Rejected (s2c)
export const RejectReason = Object.freeze({
  SchemaMismatch: 0,
  BadToken: 1,
  SessionFull: 2,
  SessionNotRunning: 3,
  ProtocolVersion: 4,
  Compatibility: 5,
  Capacity: 6,
} as const);
export type RejectReason = (typeof RejectReason)[keyof typeof RejectReason];
/** `reason > 4` decodes fine; clients treat it as unknown and display `detail`. */
export const RejectedSchema = defineSchema({ reason: f.u8, detail: f.str(256) });
export type RejectedPayload = PayloadOf<typeof RejectedSchema>;

// 9.4 SessionState (s2c)
export const PlayerState = Object.freeze({ Joined: 0, Ready: 1, Playing: 2, Away: 3 } as const);
export type PlayerState = (typeof PlayerState)[keyof typeof PlayerState];
export const PlayerEntrySchema = f.struct({
  playerId: f.u8,
  name: f.str(32),
  state: f.u8,
  entity: f.entity(), // ENTITY_NONE until spawned
});
export type PlayerEntryPayload = ReturnType<typeof PlayerEntrySchema.create>;
/** Full membership, ascending playerId, sent on every change. */
export const SessionStateSchema = defineSchema({
  players: f.array(PlayerEntrySchema, PROTOCOL_SESSION_CAPACITY_MAX),
});
export type SessionStatePayload = PayloadOf<typeof SessionStateSchema>;

// 9.5 Ready (c2s), Leave (c2s): empty payloads
export const ReadySchema = defineSchema({});
export type ReadyPayload = PayloadOf<typeof ReadySchema>;
export const LeaveSchema = defineSchema({});
export type LeavePayload = PayloadOf<typeof LeaveSchema>;

// 9.6 Spawned (s2c)
export const SpawnedSchema = defineSchema({
  playerId: f.u8,
  entity: f.entity(),
  regionId: f.str(64),
});
export type SpawnedPayload = PayloadOf<typeof SpawnedSchema>;

// 9.7 Input (c2s)
export const INPUT_FRAMES_PER_MESSAGE = 4;
/** Bit 7 of an Input's count byte: the frame ticks do not follow on, so a gap precedes each frame. */
export const INPUT_FLAG_GAPS = 0x80;
export interface InputPayload<I extends InputFrameBase = InputFrameBase> {
  firstTick: number;
  frames: I[];
}

/**
 * The Input payload (docs/protocol.md 9.7), hand-coded: `u32 firstTick | u8 count | frame 0 |
 * (varuint gap | frame) x (count - 1)`, where a frame is the InputFrame's fields after `tick` and
 * the gaps are there only when bit 7 of `count` (`INPUT_FLAG_GAPS`) is set. Frame 0's tick is
 * `firstTick`, and each later frame's the one before it plus 1 plus its gap (0 without the flag).
 * Frames must start at `firstTick` and ascend (`EncodeError('range')` otherwise). The descriptor is
 * the payload's logical struct, `struct{firstTick:u32,frames:array(<input>,4)}`.
 */
export function inputMessageSchema<I extends InputFrameBase>(
  input: Schema<I>,
): Schema<InputPayload<I>> {
  if (input.fieldNames[0] !== 'tick' || input.fields['tick']?.kind !== 'u32') {
    throw new RangeError('inputMessageSchema: the input schema must begin with tick: f.u32');
  }
  const fields = Object.freeze({
    firstTick: f.u32,
    frames: f.array(input.type, INPUT_FRAMES_PER_MESSAGE),
  });
  const descriptor = f.struct(fields).descriptor;
  // Every field after tick, in declaration order: what a frame carries on the wire.
  const names = input.fieldNames.slice(1);
  const types = names.map((name) => input.fields[name]!);
  const n = names.length;

  const encode = (w: ByteWriter, v: InputPayload<I>): void => {
    const frames = v.frames;
    const count = frames.length;
    if (count > INPUT_FRAMES_PER_MESSAGE) {
      throw new EncodeError('count', `Input: ${count} frames > ${INPUT_FRAMES_PER_MESSAGE}`);
    }
    let gaps = false;
    for (let i = 0; i < count; i++) {
      const tick = frames[i]!.tick;
      const previous = i === 0 ? v.firstTick - 1 : frames[i - 1]!.tick;
      if (
        !Number.isInteger(tick) ||
        tick <= previous ||
        tick > 0xffffffff ||
        (i === 0 && tick !== v.firstTick)
      ) {
        throw new EncodeError('range', 'Input: frame ticks must start at firstTick and ascend');
      }
      if (tick !== previous + 1) gaps = true;
    }
    w.u32(v.firstTick);
    w.u8(count | (gaps ? INPUT_FLAG_GAPS : 0));
    for (let i = 0; i < count; i++) {
      const frame = frames[i] as unknown as Record<string, unknown>;
      if (gaps && i > 0) w.varuint(frames[i]!.tick - frames[i - 1]!.tick - 1);
      for (let j = 0; j < n; j++) types[j]!.encode(w, frame[names[j]!]);
    }
  };

  /** Into `target`'s frame objects where it has them (`decodeInto`), else fresh ones. */
  const read = (r: ByteReader, target: InputPayload<I> | undefined): InputPayload<I> => {
    const firstTick = r.u32();
    const countOffset = r.offset;
    const head = r.u8();
    const count = head & ~INPUT_FLAG_GAPS;
    if (count > INPUT_FRAMES_PER_MESSAGE) {
      throw new DecodeError(
        'count',
        countOffset,
        `Input: ${count} frames > ${INPUT_FRAMES_PER_MESSAGE}`,
      );
    }
    const gaps = (head & INPUT_FLAG_GAPS) !== 0;
    const out = target ?? { firstTick, frames: [] };
    const frames = out.frames;
    let tick = firstTick;
    for (let i = 0; i < count; i++) {
      if (i > 0) {
        const gapOffset = r.offset;
        tick += 1 + (gaps ? r.varuint() : 0);
        if (tick > 0xffffffff) {
          throw new DecodeError('range', gapOffset, 'Input: frame tick beyond u32');
        }
      }
      const reused = frames[i] as unknown as Record<string, unknown> | undefined;
      if (reused === undefined) {
        // Built as f.struct's decode builds it: own keys in declaration order, tick first.
        const frame: Record<string, unknown> = { tick };
        for (let j = 0; j < n; j++) frame[names[j]!] = types[j]!.decode(r);
        frames[i] = frame as unknown as I;
      } else {
        reused['tick'] = tick;
        for (let j = 0; j < n; j++) {
          const name = names[j]!;
          reused[name] = types[j]!.decodeInto(r, reused[name]);
        }
      }
    }
    frames.length = count;
    out.firstTick = firstTick;
    return out;
  };

  const type: FieldType<InputPayload<I>> = Object.freeze({
    kind: 'struct' as const,
    descriptor,
    allocates: true,
    numeric: false,
    encode,
    decode: (r: ByteReader) => read(r, undefined),
    decodeInto: (r: ByteReader, target: InputPayload<I>) => read(r, target ?? undefined),
    create: (): InputPayload<I> => ({ firstTick: 0, frames: [] }),
    copy(v: InputPayload<I>, out: InputPayload<I>): InputPayload<I> {
      const o = out ?? { firstTick: 0, frames: [] };
      o.firstTick = v.firstTick;
      const count = v.frames.length;
      if (o.frames.length > count) o.frames.length = count;
      for (let i = 0; i < count; i++) {
        const cur = o.frames[i];
        o.frames[i] = input.copy(v.frames[i]!, cur ?? input.create());
      }
      return o;
    },
  });
  const schema: Schema<InputPayload<I>> = {
    fields,
    fieldNames: Object.freeze(Object.keys(fields)),
    type,
    descriptor,
    hash: fnv1a32(descriptor),
    allocates: true,
    create: () => type.create(),
    copy: (v, out) => type.copy(v, out),
    encode: (w, v) => encodeWith(w, schema, v),
    decode: (r) => type.decode(r),
    decodeInto: (r, target) => {
      type.decodeInto(r, target);
    },
  };
  return Object.freeze(schema);
}

// 9.8 Ack (c2s)
export const AckSchema = defineSchema({ lastSnapshotTick: f.u32 });
export type AckPayload = PayloadOf<typeof AckSchema>;

// 9.9 Ping (c2s) / Pong (s2c)
export const PingSchema = defineSchema({ clientTimeMs: f.u32 });
export type PingPayload = PayloadOf<typeof PingSchema>;
export const PongSchema = defineSchema({
  clientTimeMs: f.u32,
  serverTimeMs: f.u32,
  serverTick: f.u32,
});
export type PongPayload = PayloadOf<typeof PongSchema>;

// 9.10 RegionSet (s2c) / RegionLoadState (c2s)
/** str max for region ids. */
export const REGION_ID_MAX = 64;
export const REGION_LIST_MAX = 255;
export const RegionSetSchema = defineSchema({
  active: f.array(f.str(REGION_ID_MAX), REGION_LIST_MAX),
  prefetch: f.array(f.str(REGION_ID_MAX), REGION_LIST_MAX),
});
export type RegionSetPayload = PayloadOf<typeof RegionSetSchema>;
export const RegionLoadStateSchema = defineSchema({
  loaded: f.array(f.str(REGION_ID_MAX), REGION_LIST_MAX),
  loading: f.array(f.str(REGION_ID_MAX), REGION_LIST_MAX),
});
export type RegionLoadStatePayload = PayloadOf<typeof RegionLoadStateSchema>;

// 9.13 Kicked (s2c)
export const KickReason = Object.freeze({
  ServerShutdown: 0,
  AckTimeout: 1,
  Replaced: 2,
  Protocol: 3,
  Idle: 4,
  ByHost: 5,
} as const);
export type KickReason = (typeof KickReason)[keyof typeof KickReason];
export const KickedSchema = defineSchema({ reason: f.u8 });
export type KickedPayload = PayloadOf<typeof KickedSchema>;

/** Placeholder for the minimal input frame; SchemaRegistry swaps in the game's input schema. */
const BaseInputSchema = defineSchema({ tick: f.u32 });
/** Placeholder schema for the hand-coded Snapshot and Events payloads (9.11, 9.12). */
const HandCodedSchema = defineSchema({});

function core<T>(
  name: keyof typeof CoreKind,
  direction: MessageDirection,
  schema: Schema<T>,
): MessageDef<T> {
  return Object.freeze({ name, direction, schema, core: true });
}

/** Every core message, ascending kind, `core: true`. */
export const CORE_MESSAGES: readonly MessageDef[] = Object.freeze([
  core('Hello', 'c2s', HelloSchema),
  core('Ready', 'c2s', ReadySchema),
  core('Input', 'c2s', inputMessageSchema(BaseInputSchema)),
  core('Ack', 'c2s', AckSchema),
  core('Ping', 'c2s', PingSchema),
  core('RegionLoadState', 'c2s', RegionLoadStateSchema),
  core('Leave', 'c2s', LeaveSchema),
  core('Welcome', 's2c', WelcomeSchema),
  core('SessionState', 's2c', SessionStateSchema),
  core('Spawned', 's2c', SpawnedSchema),
  core('Snapshot', 's2c', HandCodedSchema),
  core('Events', 's2c', HandCodedSchema),
  core('Pong', 's2c', PongSchema),
  core('RegionSet', 's2c', RegionSetSchema),
  core('Rejected', 's2c', RejectedSchema),
  core('Kicked', 's2c', KickedSchema),
  core('SnapshotPart', 's2c', HandCodedSchema),
]);

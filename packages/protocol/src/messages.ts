import { CompatibilityField, type CompatibilityDescriptor } from './compatibility.ts';
import { PROTOCOL_SESSION_CAPACITY_MAX } from './constants.ts';
import { f } from './fields.ts';
import type { InputFrameBase, MessageDef, MessageDirection } from './registry.ts';
import { defineSchema, type Schema } from './schema.ts';
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
export interface InputPayload<I extends InputFrameBase = InputFrameBase> {
  firstTick: number;
  frames: I[];
}
/** `u32 firstTick | u16 count (<= 4) | InputFrame x count`. */
export function inputMessageSchema<I extends InputFrameBase>(
  input: Schema<I>,
): Schema<InputPayload<I>> {
  return defineSchema({
    firstTick: f.u32,
    frames: f.array(input.type, INPUT_FRAMES_PER_MESSAGE),
  });
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

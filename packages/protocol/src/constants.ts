import { FNV_BASIS } from '@conduit/math';

export { FNV_PRIME } from '@conduit/math';

/** u8 in every frame header. Bumped only when the envelope or a core payload changes. */
export const WIRE_VERSION = 4;
/** Default session size; remains independent of schema/protocol ceilings. */
export const DEFAULT_SESSION_CAPACITY = 8;
/** Publicly qualified capacity; larger sessions stay gated until load/reconnect/save qualification. */
export const QUALIFIED_SESSION_CAPACITY = 8;
/** Hard wire-format capacity ceiling, not a qualified support promise. */
export const PROTOCOL_SESSION_CAPACITY_MAX = 16;

/** `u8 wireVersion, u8 messageCount`. */
export const FRAME_HEADER_BYTES = 2;
/** `u8 kind, u32 tick, u16 seq, u16 payloadLength`. */
export const MESSAGE_HEADER_BYTES = 9;
/** u8 message count. */
export const MAX_MESSAGES_PER_FRAME = 255;
/** u16 payload length. */
export const MAX_PAYLOAD_BYTES = 65535;
/** Receivers discard larger frames. */
export const MAX_FRAME_BYTES = 1048576;
/** `ByteWriter` growth ceiling. */
export const MAX_WRITER_BYTES = 16777216;
/** u16 count ceiling for `f.array`. */
export const MAX_ARRAY_COUNT = 65535;
/** Ceiling for the `max` of `f.str`. */
export const MAX_STR_BYTES = 65535;
/** u8 component id. */
export const MAX_COMPONENTS = 256;
/** u8 event id. */
export const MAX_EVENTS = 256;
/** First game-defined message kind. */
export const GAME_MESSAGE_KIND_BASE = 128;
/** Game message kinds are 128..255. */
export const MAX_GAME_MESSAGES = 128;
/** Envelope seq wraps here. */
export const SEQ_MODULO = 65536;
/** `f.entity()` "no entity". */
export const ENTITY_NONE = 0;
/** Region table index meaning "no region". */
export const REGION_IDX_NONE = 255;
/** Region table entries per Snapshot/Events payload (indices 0..254). */
export const MAX_REGION_TABLE = 255;
/** 10-bit smallest-three scale (about 722.6631). */
export const QUAT_SCALE = 511 * Math.SQRT2;
/** Clamp for the three stored quaternion components. */
export const QUAT_COMPONENT_MAX = Math.SQRT1_2;
/** angle16 range. */
export const TAU = 2 * Math.PI;
/** FNV-1a 32 offset basis (alias of `FNV_BASIS` from `@conduit/math`). */
export const FNV_OFFSET = FNV_BASIS;
/** Field, component, message and event names. */
export const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

# @conduit/protocol

Package `packages/protocol`. Isomorphic, pure: no `Date`, `Math.random`, timers, or I/O. Depends only on `@conduit/math` (for the `Vec2`, `Vec3`, `Quat` plain-object types and `slerp`). Everything on the wire in conduit-core is produced by this package: the field-type DSL, the byte codec, the schema and registry hashes, the frame envelope, the core message set, and the hand-encoded Snapshot/Events payloads.

All multi-byte integers and floats are **little-endian**. All sizes are bytes.

Cross-references: component definitions and `EntityId` semantics are in docs/sim.md; regions in docs/world.md; the server/client that consume this package in docs/net.md; the worker gateway in docs/host.md.

## 1. Constants

| Name | Value | Meaning |
| --- | --- | --- |
| `WIRE_VERSION` | `4` | u8 in every frame header. Bumped only when the envelope or a core payload changes. |
| `FRAME_HEADER_BYTES` | `2` | `u8 wireVersion, u8 messageCount` |
| `MESSAGE_HEADER_BYTES` | `9` | `u8 kind, u32 tick, u16 seq, u16 payloadLength` |
| `MAX_MESSAGES_PER_FRAME` | `255` | u8 count |
| `MAX_PAYLOAD_BYTES` | `65535` | u16 length |
| `MAX_FRAME_BYTES` | `1048576` | receiver discards larger frames |
| `MAX_WRITER_BYTES` | `16777216` | ByteWriter growth ceiling |
| `MAX_ARRAY_COUNT` | `65535` | u16 count ceiling for `f.array` |
| `MAX_STR_BYTES` | `65535` | ceiling for the `max` of `f.str` |
| `MAX_COMPONENTS` | `256` | u8 component id |
| `MAX_EVENTS` | `256` | u8 event id |
| `GAME_MESSAGE_KIND_BASE` | `128` | first game-defined message kind |
| `MAX_GAME_MESSAGES` | `128` | kinds 128..255 |
| `SEQ_MODULO` | `65536` | envelope seq wraps here |
| `ENTITY_NONE` | `0` | `f.entity()` "no entity" |
| `REGION_IDX_NONE` | `255` | region table index meaning "no region" |
| `MAX_REGION_TABLE` | `255` | region table entries per Snapshot/Events (indices 0..254) |
| `QUAT_SCALE` | `511 * Math.SQRT2` | 10-bit smallest-three scale (`≈ 722.6631`) |
| `QUAT_COMPONENT_MAX` | `Math.SQRT1_2` | clamp for the three stored components |
| `TAU` | `2 * Math.PI` | angle16 range |
| `FNV_OFFSET` | `0x811C9DC5` | FNV-1a 32 offset basis (alias of `FNV_BASIS` from `@conduit/math`, docs/sim.md 1.10) |
| `FNV_PRIME` | `0x01000193` | FNV-1a 32 prime (re-exported from `@conduit/math`) |
| `NAME_PATTERN` | `/^[A-Za-z][A-Za-z0-9_]{0,63}$/` | field, component, message, event names |

## 2. Errors

```ts
export type DecodeErrorCode =
  | 'eof'        // read past the end of the reader
  | 'range'      // decoded scalar outside its domain (bool > 1, presence flag > 1, quat idx unused, field mask bit beyond the component's fields)
  | 'count'      // array count > max, region table > MAX_REGION_TABLE
  | 'length'     // str byte length > max, or payloadLength > remaining
  | 'utf8'       // invalid UTF-8 in str
  | 'varuint'    // LEB128 longer than 5 bytes or exceeding u32
  | 'version'    // frame wireVersion != WIRE_VERSION
  | 'unknown';   // unknown component/event id inside Snapshot/Events (registry mismatch)

export class DecodeError extends Error {
  readonly name = 'DecodeError';
  constructor(readonly code: DecodeErrorCode, readonly offset: number, message?: string);
}

export type EncodeErrorCode = 'range' | 'length' | 'count' | 'nan' | 'capacity' | 'payload';
export class EncodeError extends Error {
  readonly name = 'EncodeError';
  constructor(readonly code: EncodeErrorCode, message?: string);
}
```

Every read is bounds-checked and throws `DecodeError('eof', offset)` rather than returning garbage. `offset` is the absolute index into the reader's buffer of the first byte of the value that failed to decode (for `varuint` and `str`, the first byte of the LEB128 prefix); a failed `ByteReader` read leaves `reader.offset` unchanged. Decoders never partially mutate a `decodeInto` target and then throw silently: on throw the target is unspecified and the caller discards it (net.md discards the whole frame).

## 3. ByteWriter and ByteReader

```ts
export class ByteWriter {
  constructor(initialCapacity = 1024);
  readonly length: number;                 // bytes written so far
  u8(v: number): void;  i8(v: number): void;
  u16(v: number): void; i16(v: number): void;
  u32(v: number): void; i32(v: number): void;
  f32(v: number): void;
  varuint(v: number): void;
  bytes(src: Uint8Array): void;            // raw copy, no length prefix
  utf8(s: string, max: number): void;      // varuint byteLength + bytes; EncodeError('length') if byteLength > max
  reserveU8(): number;                     // writes 0x00, returns its offset
  reserveU16(): number;                    // writes 0x0000, returns its offset
  patchU8(offset: number, v: number): void;
  patchU16(offset: number, v: number): void;
  patchU32(offset: number, v: number): void;
  truncate(length: number): void;          // length must be <= current length
  view(): Uint8Array;                      // subarray [0, length) over the internal buffer; invalid after next write/reset
  finish(): Uint8Array;                    // fresh copy of [0, length); then reset()
  reset(): void;                           // length = 0, capacity kept
}
```

Rules:

- Backing store is one `ArrayBuffer` with a `DataView` and `Uint8Array` over it. Growth: when a write needs `length + n > capacity`, new capacity = `max(capacity * 2, length + n)` rounded up to a multiple of 1024 and capped at `MAX_WRITER_BYTES`; contents copied. If `length + n` exceeds `MAX_WRITER_BYTES`, throw `EncodeError('capacity')` (nothing is written).
- Integer writers require `Number.isInteger(v)` and range membership (`u8` 0..255, `i8` −128..127, `u16` 0..65535, `i16` −32768..32767, `u32` 0..4294967295, `i32` −2147483648..2147483647) and throw `EncodeError('range')` otherwise. `f32` accepts any number including NaN/±Infinity (written per IEEE-754 binary32 via `DataView.setFloat32(off, v, true)`).
- `varuint`: unsigned LEB128, `v` integer in 0..2^32−1, 1 to 5 bytes: emit `(v & 0x7F) | (more ? 0x80 : 0)` while `v >>>= 7` is non-zero.
- `patchU16(offset, v)` writes `v` at `offset` without moving `length`; `offset + 2 <= length` else `EncodeError('range')`. Same for `patchU8`/`patchU32`. `truncate(length)` above the current length also throws `EncodeError('range')`.
- `finish()` copies so the returned buffer may be handed to `ws.send` / `postMessage` while the writer is reused.

```ts
export class ByteReader {
  constructor(buf: Uint8Array, offset = 0, length = buf.byteLength - offset);
  readonly buf: Uint8Array;
  offset: number;                          // absolute index into buf
  readonly end: number;                    // offset + length at construction
  remaining(): number;                     // end - offset
  u8(): number;  i8(): number;  u16(): number; i16(): number;
  u32(): number; i32(): number; f32(): number;
  varuint(): number;
  bytes(n: number): Uint8Array;            // subarray view, no copy
  utf8(max: number): string;               // see f.str decode
  skip(n: number): void;
  sub(n: number): ByteReader;              // reader over the next n bytes; advances this reader by n
}
```

Every read checks `offset + n <= end` first and throws `DecodeError('eof', offset)`. `varuint` throws `DecodeError('varuint', offset)` if a 5th byte has bit 7 set or if the 5th byte contributes bits above bit 31 (i.e. `byte5 > 0x0F`). `u32` and `varuint` return unsigned values (`>>> 0`).

## 4. Field-type DSL

### 4.1 FieldType

```ts
export type FieldKind =
  | 'u8' | 'i8' | 'u16' | 'i16' | 'u32' | 'i32' | 'f32' | 'bool' | 'varuint'
  | 'fixed16' | 'fixed32' | 'vec2' | 'vec3' | 'quat' | 'angle16'
  | 'str' | 'entity' | 'array' | 'struct' | 'optional';

export interface FieldType<T> {
  readonly kind: FieldKind;
  readonly descriptor: string;     // canonical text, section 6
  readonly allocates: boolean;     // decodeInto may allocate even into a target of the right shape: str (new string), array (growth), optional of vec2/vec3/quat/struct/str/array (becoming present), and structs holding any of these; numbers, bool, entity, vec2, vec3, quat never allocate
  readonly numeric: boolean;       // true for u8..f32, varuint, fixed16, fixed32, angle16
  lerp?(a: T, b: T, t: number, out: T): T;   // present only where interpolation is defined (section 4.4); method syntax so FieldType<number> is assignable to FieldType<unknown>
  encode(w: ByteWriter, v: T): void;
  decode(r: ByteReader): T;        // allocates for allocating kinds
  decodeInto(r: ByteReader, target: T): T;   // reuses target where possible; returns target (or the new primitive)
  create(): T;                     // default value: 0, false, '', ENTITY_NONE, identity quat, empty array, struct of defaults, undefined
  copy(v: T, out: T): T;           // deep copy into out (allocating kinds), or returns v (primitives)
}

export type FieldMap = { readonly [name: string]: FieldType<unknown> };
export type NumericFieldType = FieldType<number> & { readonly numeric: true };
```

### 4.2 Constructors and encodings

```ts
export const f: {                  // numeric constructors return NumericFieldType so they can be vec2/vec3 elements
  u8: NumericFieldType;  i8: NumericFieldType;
  u16: NumericFieldType; i16: NumericFieldType;
  u32: NumericFieldType; i32: NumericFieldType;
  f32: NumericFieldType;
  bool: FieldType<boolean>;
  varuint: NumericFieldType;
  fixed16(scale: number): NumericFieldType;
  fixed32(scale: number): NumericFieldType;
  vec2(elem: NumericFieldType): FieldType<Vec2>;
  vec3(elem: NumericFieldType): FieldType<Vec3>;
  quat(): FieldType<Quat>;
  angle16(): NumericFieldType;
  str(max: number): FieldType<string>;
  entity(): FieldType<EntityId>;
  array<E>(elem: FieldType<E>, max: number): FieldType<E[]>;
  struct<F extends FieldMap>(fields: F): FieldType<Infer<F>>;
  optional<E>(of: FieldType<E>): FieldType<E | undefined>;
};
export type EntityId = number;   // u32; single definition, re-exported by @conduit/sim together with ENTITY_NONE; docs/sim.md 2.1 defines the slot/generation layout; 0 is never a live entity
```

| Type | Bytes | Encode | Decode | Decode errors |
| --- | --- | --- | --- | --- |
| `u8` `i8` `u16` `i16` `u32` `i32` | 1/1/2/2/4/4 | writer method; `EncodeError('range')` if not integer in range | reader method | `eof` |
| `f32` | 4 | IEEE-754 binary32 LE | `getFloat32(off, true)` | `eof` |
| `bool` | 1 | `false → 0x00`, `true → 0x01` | `0 → false`, `1 → true` | `eof`; `range` if byte > 1 |
| `varuint` | 1–5 | LEB128 (section 3) | LEB128 | `eof`, `varuint` |
| `fixed16(scale)` | 2 | `q = clamp(Math.round(v / scale), -32768, 32767)` as i16; `v` NaN → `EncodeError('nan')`; ±Infinity clamp | `q * scale` | `eof` |
| `fixed32(scale)` | 4 | same with i32 range | `q * scale` | `eof` |
| `vec2(elem)` | 2×elem | `elem.encode(x)`, `elem.encode(y)` | `{x, y}` | elem's |
| `vec3(elem)` | 3×elem | `x`, `y`, `z` | `{x, y, z}` | elem's |
| `quat()` | 4 | smallest-three u32 (4.3) | 4.3 | `eof` |
| `angle16()` | 2 | `u = Math.round(frac(v / TAU) * 65536) & 0xFFFF` where `frac(x) = ((x % 1) + 1) % 1`; NaN → `EncodeError('nan')`; ±Infinity → `EncodeError('nan')` | `u * TAU / 65536`, in `[0, TAU)` | `eof` |
| `str(max)` | varuint + n | UTF-8 via `TextEncoder`; lone surrogates become U+FFFD; `byteLength > max` → `EncodeError('length')` | varuint n; `n > max` → `DecodeError('length')`; `n > remaining` → `eof`; decode with `TextDecoder('utf-8', { fatal: true, ignoreBOM: true })` (so a leading U+FEFF round-trips), throw → `DecodeError('utf8')` | `length`, `eof`, `utf8` |
| `entity()` | 4 | u32; `ENTITY_NONE = 0` means none | u32 | `eof` |
| `array(elem, max)` | 2 + Σelem | u16 count then elements in index order; `count > max` → `EncodeError('count')` | u16 count; `count > max` → `DecodeError('count')`; then elements | `count`, elem's |
| `struct(fields)` | Σfields | fields in declaration order (`Object.keys(fields)` order) | same order | field's |
| `optional(of)` | 1 (+ of) | `0x00` when `v === undefined`, else `0x01` + `of.encode(v)` | `0 → undefined`, `1 → of.decode` | `range` if flag > 1, of's |

Constructor validation (throws `RangeError` at definition time):

- `fixed16`/`fixed32`: `scale` finite and `> 0`.
- `vec2`/`vec3`: `elem.numeric === true`.
- `str`: `max` integer, `1 <= max <= MAX_STR_BYTES`.
- `array`: `max` integer, `1 <= max <= MAX_ARRAY_COUNT`.
- `struct`: at least zero fields (empty allowed); every key matches `NAME_PATTERN`; keys are unique by construction.
- `optional(optional(x))` is rejected.
- Element, field and inner types passed to `vec2`/`vec3`/`array`/`struct`/`optional` must be field types built with `f.*` (e.g. `f.quat` without the call is rejected).

`create()` values: numbers `0`, `bool` `false`, `str` `''`, `entity` `0`, `vec2` `{x:0,y:0}`, `vec3` `{x:0,y:0,z:0}`, `quat` `{x:0,y:0,z:0,w:1}`, `angle16` `0`, `array` `[]`, `struct` every field `create()`d, `optional` `undefined`.

### 4.3 quat smallest-three

Input `q = {x, y, z, w}`. Let `c = [x, y, z, w]`.

```
encode(q):
  len = sqrt(x²+y²+z²+w²)
  if !(len > 0) or len is not finite (a NaN or ±Infinity component): c = [0,0,0,1]   // degenerate → identity
  else if |len − 1| > 1e-6: c = c / len
  i = index of max |c[k]| (k = 0..3); ties → lowest index
  if c[i] < 0: c = −c                                          // dropped component normalized positive
  others = c with index i removed, in ascending index order    // 3 values
  for each k in 0..2:
     v = clamp(others[k], −QUAT_COMPONENT_MAX, QUAT_COMPONENT_MAX)
     s[k] = clamp(round(v * QUAT_SCALE), −511, 511)            // signed 10-bit, two's complement in the field
  packed = (i << 30) | ((s[0] & 0x3FF) << 20) | ((s[1] & 0x3FF) << 10) | (s[2] & 0x3FF)
  w.u32(packed >>> 0)

decode():
  p = r.u32()
  i = p >>> 30
  s[0] = sext10((p >>> 20) & 0x3FF); s[1] = sext10((p >>> 10) & 0x3FF); s[2] = sext10(p & 0x3FF)
  where sext10(u) = u >= 512 ? u − 1024 : u
  v[k] = s[k] / QUAT_SCALE
  dropped = sqrt(max(0, 1 − v[0]² − v[1]² − v[2]²))
  place v[0..2] into the three indices ≠ i in ascending index order; place dropped at index i
  return {x: c[0], y: c[1], z: c[2], w: c[3]}
```

| bits | 31–30 | 29–20 | 19–10 | 9–0 |
| --- | --- | --- | --- | --- |
| field | dropped index `i` (0=x 1=y 2=z 3=w) | `s[0]` | `s[1]` | `s[2]` |

`s[k] = −512` never appears in encoded output; decoders accept it (it decodes to `−512/QUAT_SCALE`). Round trip error per component ≤ `1 / (2 · QUAT_SCALE) ≈ 0.0007`. Property tests assert `|dot(q, decode(encode(q)))| > 0.9999` for random unit quaternions and that `q` and `−q` encode identically.

### 4.4 Interpolation (`lerp`)

`lerp` is defined for exactly these kinds; others have `lerp === undefined`.

| Kind | `lerp(a, b, t, out)` |
| --- | --- |
| integer kinds, `varuint`, `f32`, `fixed16/32` | `a + (b − a) * t` (integers are not re-rounded; the consumer rounds if it needs an integer) |
| `vec2`, `vec3` | component-wise into `out`, each component with the element type's `lerp` (so `vec2(angle16())` takes the shortest arc per component) |
| `quat` | `q.slerp(a, b, t, out)` from `@conduit/math` (docs/sim.md 1.6): if `dot(a, b) < 0`, `b` is negated first (shortest path); if the resulting `dot > 1 − EPS` (`EPS = 1e-6`) it falls back to normalized lerp |
| `angle16` | `d = ((b − a + π) mod TAU) − π` (mod into `[0, TAU)`), result `frac((a + d * t) / TAU) * TAU` (shortest arc) |

`t` is clamped to `[0, 1]` by the caller (docs/net.md), not by `lerp`.

### 4.5 `Infer`

```ts
export type Infer<F> =
  F extends FieldType<infer T> ? T :
  F extends FieldMap ? { [K in keyof F]: Infer<F[K]> } :
  never;
```

| DSL | TypeScript |
| --- | --- |
| `u8 i8 u16 i16 u32 i32 f32 varuint fixed16 fixed32 angle16` | `number` |
| `bool` | `boolean` |
| `vec2(e)` | `Vec2` (`{x: number; y: number}`) |
| `vec3(e)` | `Vec3` |
| `quat()` | `Quat` (`{x,y,z,w}`) |
| `str(n)` | `string` |
| `entity()` | `EntityId` (`number`) |
| `array(e, n)` | `Infer<e>[]` |
| `struct(fs)` | `{ [K in keyof fs]: Infer<fs[K]> }` |
| `optional(e)` | `Infer<e> \| undefined` (key present, value may be `undefined`) |

## 5. Schema

```ts
export interface Schema<T> {
  readonly fields: FieldMap;                 // as passed (frozen shallow copy)
  readonly fieldNames: readonly string[];    // declaration order
  readonly type: FieldType<T>;               // f.struct(fields)
  readonly descriptor: string;               // type.descriptor
  readonly hash: number;                     // fnv1a32(descriptor), u32
  readonly allocates: boolean;               // true if any field allocates
  create(): T;
  copy(v: T, out: T): T;
  encode(w: ByteWriter, v: T): void;
  decode(r: ByteReader): T;
  decodeInto(r: ByteReader, target: T): void;
}
export function defineSchema<F extends FieldMap>(fields: F): Schema<Infer<F>>;
```

### 5.1 `encodeWith`, `decodeWith`, `decodeInto`

```ts
export function encodeWith<T>(w: ByteWriter, schema: Schema<T>, value: T): void;
export function decodeWith<T>(r: ByteReader, schema: Schema<T>): T;
export function decodeInto<T>(r: ByteReader, schema: Schema<T>, target: T): void;
```

- `encodeWith` records `w.length`, calls `schema.type.encode`, and on any throw (an `EncodeError`, or any other error from a field encoder such as a missing nested object) truncates the writer back to the recorded length before rethrowing. Writers never carry a half-written value. `schema.encode(w, v)` behaves the same; the per-kind `FieldType.encode` does not truncate.
- `decodeWith` allocates a fresh `T` (`schema.type.decode`).
- `decodeInto` reuses `target`. Per kind:

| Kind | `decodeInto` behaviour | Allocates? |
| --- | --- | --- |
| primitives (numbers, bool, entity, angle16) | returns the new value; the struct decoder assigns it to the field | no |
| `str` | returns a new string (immutable) | yes (string) |
| `vec2`/`vec3`/`quat` | writes components into `target`; if `target` is `null`/`undefined` allocates | only when missing |
| `array` | sets `target.length = count`; for element kinds that allocate, reuses `target[i]` when present else allocates; primitives assigned | on growth |
| `struct` | recurses into each field via `decodeInto`; assigns returned primitives | only for missing sub-objects |
| `optional` | flag 0 → field set to `undefined`; flag 1 → `decodeInto(existing)` if `existing !== undefined` else `decode()` | when becoming present |

The allocation-free hot path therefore holds for components composed of numbers, vectors, quats, bools and entities (`Transform` and `Owner` qualify; `Region`, `Model` and `Name` hold strings). A schema whose `allocates` is `false` (no field allocates, section 4.1) guarantees `decodeInto` performs zero allocations into a target of the right shape (from `create()` or an earlier decode).

### 5.2 Field subsets: `fieldMaskBytes`, `encodeFields`, `decodeFields`

```ts
export function fieldMaskBytes<T>(schema: Schema<T>): 0 | 1 | 2;
export function encodeFields<T>(w: ByteWriter, schema: Schema<T>, value: Partial<T>, mask: number): void;
export function decodeFields<T>(r: ByteReader, schema: Schema<T>, mask: number): Partial<T>;
```

A field mask selects top-level fields of a schema: bit `i` (bit 0 is the least significant) selects `schema.fieldNames[i]`. With `N = schema.fieldNames.length`, a mask is valid when it is an integer in `0 … 2^N − 1` and `N ≤ 16`; masks never address more than 16 fields. Masked Snapshot updates (9.11.1) are the only wire use.

- `fieldMaskBytes`: `1` when `N ≤ 8` (including an empty schema), `2` when `9 ≤ N ≤ 16`, `0` when `N > 16` (such a value has no mask and is always encoded whole).
- `encodeFields` writes `schema.fields[name].encode(w, value[name])` for each selected field in declaration order, and nothing else: no mask bytes, and unselected fields are neither written nor read, so `value` may be a partial object. An invalid mask (or `N > 16`) throws `EncodeError('range')` before anything is written. Like `encodeWith`, any throw truncates the writer back to its length before the call. The mask `2^N − 1` writes exactly the bytes of `encodeWith`.
- `decodeFields` reads the selected fields in declaration order with `FieldType.decode` into a fresh object whose own keys are exactly the selected field names, in declaration order; unselected fields are absent, not `undefined`. Decode errors are the fields' own. An invalid mask throws `RangeError` before reading: it is a caller bug, since a decoder that reads a mask off the wire validates it first and reports `DecodeError('range')` at the mask's offset (9.11.1).

## 6. Descriptor grammar and hashing

Every `FieldType.descriptor` is produced by this grammar (no whitespace, ASCII only):

```
type      := 'u8' | 'i8' | 'u16' | 'i16' | 'u32' | 'i32' | 'f32' | 'bool' | 'varuint'
           | 'fixed16(' num ')' | 'fixed32(' num ')'
           | 'vec2(' type ')' | 'vec3(' type ')'
           | 'quat' | 'angle16'
           | 'str(' int ')' | 'entity'
           | 'array(' type ',' int ')'
           | 'struct{' fields '}'
           | 'optional(' type ')'
fields    := '' | field (',' field)*
field     := name ':' type                       // declaration order
name      := NAME_PATTERN
int       := ASCII decimal digits, no leading zeros ('0' alone allowed)
num       := ECMAScript Number.prototype.toString(10) of the scale (shortest round-trip form, e.g. '0.001', '1', '1e-7')
```

Example: `Transform` → `struct{pos:vec3(fixed32(0.001)),rot:quat,vel:vec3(f32)}`.

```ts
export function fnv1a32(text: string): number;   // over UTF-8 bytes of text; the implementation is @conduit/math's fnv1a32 (docs/sim.md 1.10), re-exported here
```

```
h = FNV_OFFSET
for each byte b of utf8(text):
  h = h ^ b
  h = Math.imul(h, FNV_PRIME) >>> 0
return h >>> 0
```

`fnv1a32('')` = `0x811C9DC5`; `fnv1a32('a')` = `0xE40C292C` (test vectors).

## 7. Registry

```ts
export interface ComponentLike<T = unknown> {
  readonly name: string;
  readonly schema: Schema<T>;
  readonly replicate: boolean;
  readonly interpolate: readonly string[];     // field names, subset of schema.fieldNames
  readonly extrapolateWith?: string;           // field name
}
export type MessageDirection = 'c2s' | 's2c' | 'both';
export interface MessageDef<T = unknown> { readonly name: string; readonly direction: MessageDirection; readonly schema: Schema<T>; readonly core: boolean }
export interface EventDef<T = unknown>   { readonly name: string; readonly schema: Schema<T>; readonly replicate: boolean }
export interface RegistryInput {
  components: readonly ComponentLike[];
  messages: readonly MessageDef[];             // game messages only; core messages are implicit
  events: readonly EventDef[];
  input: Schema<InputFrameBase>;               // from defineInput
}
export interface InputFrameBase { tick: number }

export class SchemaRegistry {
  constructor(input: RegistryInput);
  readonly hash: number;                                    // u32, section 7.2
  readonly input: Schema<InputFrameBase>;
  readonly components: readonly ComponentLike[];            // index = component id
  readonly replicated: readonly ComponentLike[];            // replicate === true, ascending id
  componentId(c: ComponentLike | string): number;           // throws RangeError if unknown
  component(id: number): ComponentLike | undefined;
  readonly messages: readonly MessageDef[];                 // core + game, index = kind (holes undefined)
  messageKind(m: MessageDef | string): number;
  message(kind: number): MessageDef | undefined;
  readonly events: readonly EventDef[];                     // index = event id
  eventId(e: EventDef | string): number;
  event(id: number): EventDef | undefined;
  descriptor(): string;                                     // section 7.2
}
```

Object resolution validates schema descriptors and metadata instead of trusting names alone.
`componentId` checks `replicate`, optional `persist` (default false), `interpolate` and
`extrapolateWith`; `eventId` checks replication; `messageKind` checks direction and core status.
String lookups intentionally resolve a registered name. Equivalent module copies are accepted;
conflicts throw `RangeError`. Immutable definitions are cached per registry. Mutable definition
shells are copied; schemas must have immutable metadata (as `defineSchema` produces). Definitions
have no unscoped `.id`; use these registry APIs. These checks do not change the wire descriptor.

### 7.1 Id assignment

- **Components**: sort by `name` using code-unit order (`a < b`); id = index, u8. `> MAX_COMPONENTS` → `RangeError`. Duplicate names → `RangeError`. All components get ids, replicated or not, so server and client agree regardless of which side uses which.
- **Messages**: core kinds are fixed (section 9). Game messages: sort by name, kind = `GAME_MESSAGE_KIND_BASE + index`. `> MAX_GAME_MESSAGES` → `RangeError`. A game message named like a core message → `RangeError`. The registry's `Input` entry (kind 3) carries `inputMessageSchema(input)` built from `RegistryInput.input`, so `message(CoreKind.Input).schema` decodes real Input payloads and enters the descriptor.
- **Events**: sort by name, id = index, u8. `> MAX_EVENTS` → `RangeError`.
- In every list, names must match `NAME_PATTERN` and be unique (else `RangeError`); `input` must begin with `tick: f.u32` (else `RangeError`). `componentId`/`messageKind`/`eventId` look definitions up by `name`.
- Sorting makes ids independent of import order (tested by permuting the input arrays).

### 7.2 Registry hash

`hash = fnv1a32(descriptor())` where

```
registry := 'wire=' int
            ';components[' centry (';' centry)* ']'
            ';messages[' mentry (';' mentry)* ']'
            ';events[' eentry (';' eentry)* ']'
            ';input=' type
centry   := name '=' type ':' ('r' | 'n')                  // r = replicated, n = not
mentry   := int ':' name '=' type ':' ('c2s' | 's2c' | 'both')   // int = kind; core messages included
eentry   := name '=' type ':' ('r' | 'n')
```

Entries in id order. Empty lists produce `components[]`. `wire=` is `WIRE_VERSION`. Changing any field, name, scale, max, direction, replicate flag, or the order of ids changes the hash. `interpolate`/`extrapolateWith` do not enter the hash (client-only metadata shipped with the same bundle).

## 8. Envelope

```
Frame:   u8 wireVersion | u8 messageCount | Message × messageCount
Message: u8 kind | u32 tick | u16 seq | u16 payloadLength | payload[payloadLength]
```

| Offset | Size | Field | Notes |
| --- | --- | --- | --- |
| 0 | 1 | wireVersion | `WIRE_VERSION` |
| 1 | 1 | messageCount | 0..255; 0 is legal (keepalive) |
| 2+ | 9 each | message header | followed by payload |

Message header:

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 1 | kind |
| 1 | 4 | tick |
| 5 | 2 | seq |
| 7 | 2 | payloadLength |
| 9 | n | payload |

Semantics:

- **tick**, client → server: the client's `clock.serverTickNow()` estimate at send time; `0` before `Welcome`. Server → client: the server's `world.tick` at send time. For `Snapshot` it equals the header's `serverTick`.
- **seq**: one counter per direction per socket, starting at `0` on the first message after the socket opens (a reconnect starts a new socket and a new counter), incremented by 1 per message, modulo `SEQ_MODULO`. Comparison uses serial arithmetic: `seqAfter(a, b) = ((a - b) & 0xFFFF) !== 0 && ((a - b) & 0xFFFF) < 0x8000`. Receivers use `seq` for diagnostics (gap counting) and, in `Snapshot.lastInputSeq`, to echo which `Input` message was last applied. Nothing is reordered or dropped on seq alone.
- **Unknown kind**: skipped by `payloadLength`; counted in stats. A known kind whose payload fails to decode raises `DecodeError`; the caller discards the whole frame (docs/net.md says who closes).
- `payloadLength > remaining` → `DecodeError('length')`. `wireVersion !== WIRE_VERSION` → `DecodeError('version')`. Frame longer than `MAX_FRAME_BYTES` → `DecodeError('length')` before parsing.
- A payload longer than `MAX_PAYLOAD_BYTES` cannot be framed; `FrameWriter.message` throws `EncodeError('payload')` and truncates back to before the message header.

```ts
export interface MessageHeader { kind: number; tick: number; seq: number; length: number }
export class FrameWriter {
  constructor(writer?: ByteWriter);             // default new ByteWriter(4096)
  begin(): void;                                // writes wireVersion, reserves count
  message(kind: number, tick: number, seq: number, encodePayload: (w: ByteWriter) => void): void;
  readonly count: number;
  finish(): Uint8Array;                         // patches count, returns copy, resets
  abort(): void;                                // discard partial frame
}
export function readFrame(buf: Uint8Array, onMessage: (h: MessageHeader, payload: ByteReader) => void): void;
```

`begin()` resets the writer (a `FrameWriter` owns its `ByteWriter`); `message()`/`finish()` before `begin()` throw. `message()` writes the header with `payloadLength = 0`, calls `encodePayload`, computes the length, checks `<= MAX_PAYLOAD_BYTES`, then `patchU16`. If `encodePayload` (or a header field out of range, `EncodeError('range')`) throws, the writer is truncated to the pre-header length and the error rethrown; `count` is unchanged. `count === 255` → the next `message()` throws `EncodeError('count')`; senders start a new frame. `readFrame` first validates the whole frame's structure (size, version, every header and `payloadLength`, and no bytes after the last message, else `DecodeError('length')`), so no callback runs for a malformed frame; it then parses headers, gives each callback a fresh `MessageHeader` and a `ByteReader` limited to the payload (`reader.sub(length)`), and after the callback returns advances to the next message regardless of how much the callback consumed.

## 9. Core messages

Kinds (u8, exported as `CoreKind`):

| Name | Kind | Direction | Payload schema |
| --- | --- | --- | --- |
| `Hello` | 1 | c2s | 9.1 |
| `Ready` | 2 | c2s | empty |
| `Input` | 3 | c2s | 9.7 |
| `Ack` | 4 | c2s | 9.8 |
| `Ping` | 5 | c2s | 9.9 |
| `RegionLoadState` | 6 | c2s | 9.10 |
| `Leave` | 7 | c2s | empty |
| `Welcome` | 32 | s2c | 9.2 |
| `SessionState` | 33 | s2c | 9.4 |
| `Spawned` | 34 | s2c | 9.6 |
| `Snapshot` | 35 | s2c | 9.11 (hand-coded) |
| `Events` | 36 | s2c | 9.12 (hand-coded) |
| `Pong` | 37 | s2c | 9.9 |
| `RegionSet` | 38 | s2c | 9.10 |
| `Rejected` | 39 | s2c | 9.3 |
| `Kicked` | 40 | s2c | 9.13 |
| game messages | 128–255 | per def | `defineMessage` |

All non-hand-coded payloads are `defineSchema` structs and follow section 4 byte-for-byte. `CORE_MESSAGES: readonly MessageDef[]` exports each with `core: true`, in kind order; `CoreKind` holds the kinds above as a frozen `as const` object plus a same-named union type (`export type CoreKind = (typeof CoreKind)[keyof typeof CoreKind]`); the package uses no TypeScript `enum`, and `RejectReason`, `PlayerState` and `KickReason` follow the same pattern. The `Snapshot` and `Events` entries carry the placeholder schema `defineSchema({})` (descriptor `struct{}`) because their payloads are hand-coded; the `Input` entry carries `inputMessageSchema(defineInput({ tick: f.u32 }))`, which `SchemaRegistry` replaces with the game's input (section 7.1).

### 9.1 Hello (c2s, kind 1)

```ts
export const HelloSchema = defineSchema({
  maxSessionCapacity: f.optional(f.u8), // client admission/decode limit
  snapshotLimits: f.optional(SnapshotLimitsField),
  compatibility: f.optional(CompatibilityField), // explicit descriptor; absent = schema-only migration mode
  protocolVersion: f.u16,        // game.protocolVersion from defineGame (not WIRE_VERSION)
  registryHash:    f.u32,        // SchemaRegistry.hash
  sessionToken:    f.str(2048),  // minted by the lobby (docs/host.md §6 joinSession); any string in createServer devAuth mode (docs/persist.md 2.4)
  reconnectToken:  f.str(64),    // '' for a fresh join
  displayName:     f.str(32),
});
```

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 1 or 2 | maxSessionCapacity presence byte and optional u8 |
| … | variable | snapshotLimits presence byte and optional limits |
| … | variable | compatibility presence byte, then descriptor when present |
| … | 2 | protocolVersion |
| … | 4 | registryHash |
| … | varuint+n | sessionToken |
| … | varuint+n | reconnectToken |
| … | varuint+n | displayName |

`CompatibilityField` carries `u8 descriptorVersion` (1), `str(11) mode` (`declared` or
`schema-only`), `str(64) gameId`, `str(128) simulationRevision`, then at most 16 sorted,
unique `{ name: str(64), digest: str(128) }` entries. Strings are bounded in UTF-8 bytes. Declared
mode requires a nonempty revision; schema-only requires empty revision/digests. Decoders reject
invalid modes/versions/order before admission. Maximal Hello metadata plus token remains below
65,536 bytes (tested). Runtime senders always provide a descriptor; optional absence supports
low-level schema-only callers during migration and never admits them to a declared session.

This is a coordinated wire version 4 rollout. Endpoints with a different wire version reject
frame headers; gateway and worker use the same version and Hello codec. Upgrade client/server/
gateway bundles together. `protocolVersion` still identifies the consumer message contract,
`registryHash` identifies schemas, and the compatibility descriptor identifies declared
simulation/data revisions. None proves that an untrusted client executes honest code.

### 9.2 Welcome (s2c, kind 32)

```ts
export const WelcomeSchema = defineSchema({
  sessionCapacity: f.optional(f.u8), // actual pinned server capacity
  snapshotLimits: f.optional(SnapshotLimitsField),
  compatibility: f.optional(CompatibilityField), // accepted pinned descriptor
  playerId: f.u8, reconnectToken: f.str(64), simTickRate: f.u8, snapshotEvery: f.u8,
  serverTick: f.u32, serverTimeMs: f.u32, worldSeed: f.u32,
});
```

Fixed part after the token: `u8 simTickRate | u8 snapshotEvery | u32 serverTick | u32 serverTimeMs | u32 worldSeed`. `serverTick`/`serverTimeMs` are the tick and tick-start time of the tick in which the Welcome was produced (a clock sample).

### 9.3 Rejected (s2c, kind 39)

```ts
export const RejectReason = { SchemaMismatch: 0, BadToken: 1, SessionFull: 2, SessionNotRunning: 3, ProtocolVersion: 4, Compatibility: 5, Capacity: 6 } as const;
export type RejectReason = (typeof RejectReason)[keyof typeof RejectReason];
export const RejectedSchema = defineSchema({ reason: f.u8, detail: f.str(256) });
```

Decoding a `reason > 6` is not an error; clients treat it as unknown and display `detail`.

### 9.4 SessionState (s2c, kind 33)

```ts
export const PlayerState = { Joined: 0, Ready: 1, Playing: 2, Away: 3 } as const;
export type PlayerState = (typeof PlayerState)[keyof typeof PlayerState];
export const PlayerEntrySchema = f.struct({ playerId: f.u8, name: f.str(32), state: f.u8, entity: f.entity() });
export const SessionStateSchema = defineSchema({ players: f.array(PlayerEntrySchema, PROTOCOL_SESSION_CAPACITY_MAX) });
```

`entity` is `ENTITY_NONE` until spawned. The list is the full membership (ascending `playerId`), sent on every change.

`PROTOCOL_SESSION_CAPACITY_MAX` is sixteen, a codec ceiling. `DEFAULT_SESSION_CAPACITY` and
`QUALIFIED_SESSION_CAPACITY` remain eight. Hello advertises a client limit from one through
sixteen; omitted low-level limits mean eight. The server rejects an insufficient client limit
with `Capacity` before spawning or rebinding. Welcome declares the actual capacity; the client
checks it and subsequent membership IDs/counts. These fields do not enable an unqualified
sixteen-player lobby. Experimental qualification and any SQLite migration are separate gates.

### 9.5 Ready (c2s, kind 2), Leave (c2s, kind 7)

`defineSchema({})`; payloadLength 0.

### 9.6 Spawned (s2c, kind 34)

`defineSchema({ playerId: f.u8, entity: f.entity(), regionId: f.str(64) })`.

### 9.7 Input (c2s, kind 3)

```ts
export interface InputPayload<I extends InputFrameBase = InputFrameBase> { firstTick: number; frames: I[] }
export function inputMessageSchema<I extends InputFrameBase>(input: Schema<I>): Schema<InputPayload<I>> {
  return defineSchema({ firstTick: f.u32, frames: f.array(input.type, INPUT_FRAMES_PER_MESSAGE) });
}
export const INPUT_FRAMES_PER_MESSAGE = 4;
```

Layout: `u32 firstTick | u16 count (≤ 4) | InputFrame × count`. Validity (enforced by the receiver, not the codec): `count ≥ 1`, `frames[0].tick === firstTick`, `frames[i+1].tick > frames[i].tick`. The InputFrame schema comes from `defineInput` (section 10) and must begin with a `tick: f.u32` field — `tick` is the **first** field so a server can read the tick without decoding the rest.

### 9.8 Ack (c2s, kind 4)

`defineSchema({ lastSnapshotTick: f.u32 })`.

### 9.9 Ping (c2s, kind 5) / Pong (s2c, kind 37)

`PingSchema = defineSchema({ clientTimeMs: f.u32 })`; `PongSchema = defineSchema({ clientTimeMs: f.u32, serverTimeMs: f.u32, serverTick: f.u32 })`. Time values are `ms mod 2^32`; consumers subtract with `(a - b) | 0` semantics only over windows shorter than 24 days.

### 9.10 RegionSet (s2c, kind 38) / RegionLoadState (c2s, kind 6)

```ts
export const REGION_ID_MAX = 64;          // str max for region ids
export const REGION_LIST_MAX = 255;
export const RegionSetSchema       = defineSchema({ active: f.array(f.str(64), 255), prefetch: f.array(f.str(64), 255) });
export const RegionLoadStateSchema = defineSchema({ loaded: f.array(f.str(64), 255), loading: f.array(f.str(64), 255) });
```

Lists are sets: no duplicates, ascending code-unit order, `active ∩ prefetch = ∅`, `loaded ∩ loading = ∅`. Receivers de-duplicate defensively.

### 9.11 Snapshot (s2c, kind 35) — hand-coded

```ts
export const SNAPSHOT_FLAG_FULL = 0x01;
export const SNAPSHOT_FLAG_MASKED = 0x02;                                  // 9.11.1
export interface SnapshotHeader { serverTick: number; serverTimeMs: number; baselineTick: number; lastInputSeq: number; lastInputTick: number; flags: number }
export interface SnapshotComponent { id: number; value: unknown; mask?: number | undefined }   // value typed by registry.component(id).schema; mask: 9.11.1 (value then holds only the flagged fields)
export interface SnapshotCreate  { entity: EntityId; regionIdx: number; components: SnapshotComponent[] }
export interface SnapshotUpdate  { entity: EntityId; components: SnapshotComponent[]; removed: number[] }
export interface SnapshotData    { header: SnapshotHeader; regions: string[]; creates: SnapshotCreate[]; updates: SnapshotUpdate[]; destroys: EntityId[] }
export function encodeSnapshot(w: ByteWriter, registry: SchemaRegistry, s: SnapshotData): void;
export function decodeSnapshot(r: ByteReader, registry: SchemaRegistry): SnapshotData;   // allocates fresh component values
export function writeSnapshotHeader(w: ByteWriter, h: SnapshotHeader): void;              // the 19 header bytes
export function readSnapshotHeader(r: ByteReader, out?: SnapshotHeader): SnapshotHeader;
```

Header (19 bytes):

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 4 | serverTick |
| 4 | 4 | serverTimeMs |
| 8 | 4 | baselineTick (tick of the previous snapshot sent to this client; 0 if none or FULL) |
| 12 | 2 | lastInputSeq (envelope seq of the Input message whose frame was last applied; 0 if none) |
| 14 | 4 | lastInputTick (tick of the last applied input frame; 0 if none) |
| 18 | 1 | flags (bit0 FULL, bit1 MASKED (9.11.1), bit2 STATE_TICKS (9.11.2); other bits must be 0, masked off on decode) |

Body:

```
u8  regionCount                       // ≤ MAX_REGION_TABLE
    str(64) regionId × regionCount    // local table; index = position; REGION_IDX_NONE = no region
u16 createCount
    per create:
      u32 entity
      u8  regionIdx                   // index into table or REGION_IDX_NONE
      u8  compCount
      per component: u8 compId | component payload (registry.component(compId).schema, section 4)
u16 updateCount
    per update:
      u32 entity
      u8  compCount
      per component: u8 compId | payload    // MASKED: u8 compId | u8 or u16 mask | flagged fields (9.11.1)
      u8  removedCount
      u8  compId × removedCount
u16 destroyCount
    u32 entity × destroyCount
```

Ordering rules (producer): creates, updates and destroys each in ascending `entity` id; components within a record in ascending `compId`; region table in first-use order. Decode errors: `regionCount > MAX_REGION_TABLE` → `count`; `regionIdx ≥ regionCount && regionIdx !== REGION_IDX_NONE` → `range`; `compId` (in a component record or the removed list) not a replicated component → `unknown`; a field mask with a bit at or above the component's field count → `range` (9.11.1); anything else → the component schema's errors. Encode errors: more than `MAX_REGION_TABLE` regions, 255 components or removed ids in a record, or 65535 creates/updates/destroys → `EncodeError('count')`; a `regionIdx` outside the table, a component id that is not replicated, flag bits other than FULL, MASKED and STATE_TICKS, or a `mask` that 9.11.1 does not allow → `EncodeError('range')`; on any throw the writer is truncated back to where the snapshot started.

#### 9.11.1 Field masks

Whole-component updates remain the default when replication budgeting is disabled. Opt-in per-client replication uses quantized wire field comparisons and emits MASKED updates for schemas with at most 16 fields. ReplicaWorld merges those partial values into owned complete baselines before copying samples.

**Flag.** `SNAPSHOT_FLAG_MASKED = 0x02` is bit 1 of the header `flags`. With it clear, the payload is the 9.11 layout byte for byte and no record carries a mask, so every snapshot encoded without the flag is identical to what the codec wrote before masks existed. With it set, update component records change as below; the header, the region table, creates (always whole), removed lists and destroys do not. FULL and MASKED are independent bits.

**Layout.** The mask width comes from the component's schema (`fieldMaskBytes`, 5.2), never from the wire. With `N = registry.component(compId).schema.fieldNames.length`, each update component record of a MASKED snapshot is:

| N | Record |
| --- | --- |
| 0–8 | `u8 compId` \| `u8 mask` \| flagged fields |
| 9–16 | `u8 compId` \| `u16 mask` \| flagged fields |
| > 16 | `u8 compId` \| payload (no mask: always sent whole) |

Bit `i` of the mask (bit 0 is the least significant; the `u16` is little-endian, so its first byte holds fields 0–7) flags `schema.fieldNames[i]`, the component's `i`-th top-level field in declaration order. The flagged fields follow the mask in declaration order, each encoded by its own field type (section 4); unflagged fields take no bytes. Only top-level fields are addressable: a flagged `vec2`, `vec3`, `struct`, `array` or `optional` field is sent whole. A component with no fields still carries a `u8` mask, which can only be `0x00`. Example: a component `{ hp: f.u8, pos: f.vec2(f.i16), label: f.str(8) }` with id 0 whose `hp` (7) and `label` ('ok') changed is `00 05 07 02 6f 6b` (compId, mask `0b101`, hp, label), where the whole record would also carry `pos`.

**Encoding** (`encodeSnapshot`):

- `SnapshotComponent.mask` is allowed only on an update component of a MASKED snapshot whose schema has at most 16 fields. On a create, in a snapshot without MASKED, or on a wider component it is `EncodeError('range')`.
- In a MASKED snapshot a component without `mask` (absent or `undefined`) is whole: the encoder writes the mask `2^N − 1` and then every field. Whole and partial components mix freely in one snapshot.
- `mask` must be a valid mask for the schema (5.2), an integer in `0 … 2^N − 1`; anything else (a bit at or above `N`, which is an unknown bit, or a negative, fractional or NaN value) is `EncodeError('range')`. Only the flagged fields are read from `value` (`encodeFields`), so `value` may be partial.
- A mask of `0` is legal: the record is `compId` and the mask with no field bytes, meaning the component is still present and none of its fields changed. Producers should leave such components out; decoders accept them.
- On any throw the writer is truncated back to where the snapshot started (9.11).

**Decoding** (`decodeSnapshot`):

- `readSnapshotHeader` keeps bits 0–2 of `flags` (bits 3–7 are masked off), and bit 1 selects the update record layout.
- For each update component record of a MASKED snapshot, the `compId` check runs first (`unknown`). When the schema has at most 16 fields, the mask is read with the width the schema gives (`eof` if truncated). A mask with a bit at or above `N` is `DecodeError('range')` at the mask's first byte: producer and decoder share every schema through the registry hash (section 7.2), so an unknown bit means corruption rather than a newer version, and ignoring it would misread the bytes that follow. A mask of `0` reads no field bytes and decodes to `value` `{}`.
- Creates, every record of a snapshot without MASKED, and components with more than 16 fields decode whole, as in 9.11.

**What consumers receive.** A record that carried a mask decodes to `{ id, value, mask }`: `mask` is the mask from the wire (kept even when all `N` bits are set), and `value` is a fresh object whose own keys are exactly the flagged fields, in declaration order (`decodeFields`, 5.2). Unflagged fields are absent rather than `undefined`, so a flagged `optional` field that decoded to `undefined` is still distinguishable (`name in value`). Every other record decodes to `{ id, value }` with no `mask` key and a complete value, exactly as without masks. A consumer therefore replaces its value of the component when `mask === undefined`, and otherwise merges the partial value into its last known complete value:

```
merge(schema, last, c):                                    // c.mask !== undefined; last = the latest complete value of component c.id
  next = schema.copy(last, schema.create())                // a fresh object: stored values (sample rings) are never mutated
  for i in 0 … N−1 with bit i of c.mask set:
    name = schema.fieldNames[i]; next[name] = c.value[name]   // decoded values are fresh, so ownership moves without a copy
  return next
```

Re-encoding a decoded MASKED snapshot reproduces its bytes.

The planner compares schema-encoded fields against each client's last successfully handed-off wire image. Sub-quantum writes do not emit component values. Deferred dirty values remain pending across newer global baselines. Components newly added to existing entities use full masks; partial masks require an admitted component baseline. Explicit optional `undefined`, empty arrays/strings and zero values overwrite the selected fields.

#### 9.11.2 State ticks and bounded snapshot transactions

`SNAPSHOT_FLAG_STATE_TICKS = 0x04` inserts `u32 stateTick` immediately after `u32 entity` in every create and update record. Without the flag, the original record layout is unchanged. Each stamp is at most the global header tick and cannot regress below an existing entity's admitted stamp on a delta. An empty update can prove a selected dependency member's unchanged state at that tick. Deferred members retain their older stamps. Destroy records use the global transaction tick.

`SnapshotPart` is core kind 41. Its 21-byte prefix is `u32 id | u32 tick | u32 baselineTick | u16 index | u16 count | u32 totalBytes | u8 flags`, followed by raw snapshot bytes. Flag bit0 declares an explicit reset; other flags are invalid. Parts are ordered from zero, with consistent metadata. A new ID cannot replace a pending assembly except with explicit reset part0 and baseline0; the completed payload must then be FULL. The decoded snapshot header must match the part tick/baseline.

Hello offers `snapshotLimits`; Welcome returns the effective intersection. Default limits are 4 MiB, 256 parts, 5-second inactivity and 120-second absolute lifetime. Bounds, order, byte total and timing are checked before applying or acknowledging. Direct deltas require the exact last applied global baseline and cannot supersede a pending assembly. Only a complete FULL baseline0 resets it. A corrupt/gapped transaction triggers reconnect for full resync; partial replica application invalidates the mirror before reporting failure. See [bounded replication](bounded-replication.md) for all resource and progress limits.

### 9.12 Events (s2c, kind 36) — hand-coded

```ts
export interface WireEvent { eventId: number; tick: number; regionIdx: number; payload: unknown }
export interface EventsData { regions: string[]; events: WireEvent[] }
export function encodeEvents(w: ByteWriter, registry: SchemaRegistry, e: EventsData): void;
export function decodeEvents(r: ByteReader, registry: SchemaRegistry): EventsData;
```

```
u8  regionCount | str(64) × regionCount      // local table, same rules as Snapshot
u16 eventCount
    per event: u8 eventId | u32 tick | u8 regionIdx | payload (registry.event(eventId).schema)
```

Events are in ascending `tick`, then emission order. `eventId` unknown or `replicate === false` → `DecodeError('unknown')`; a bad `regionIdx` → `DecodeError('range')`. `encodeEvents` throws `EncodeError('range')` for such an event or index and `EncodeError('count')` for more than `MAX_REGION_TABLE` regions or 65535 events, truncating the writer back.

### 9.13 Kicked (s2c, kind 40)

```ts
export const KickReason = { ServerShutdown: 0, AckTimeout: 1, Replaced: 2, Protocol: 3, Idle: 4, ByHost: 5 } as const;
export type KickReason = (typeof KickReason)[keyof typeof KickReason];
export const KickedSchema = defineSchema({ reason: f.u8 });
```

## 10. defineMessage, defineEvent, defineInput

```ts
export function defineMessage<F extends FieldMap>(name: string, direction: MessageDirection, fields: F): MessageDef<Infer<F>>;
export function defineEvent<F extends FieldMap>(name: string, fields: F, opts?: { replicate?: boolean }): EventDef<Infer<F>>;
export function defineInput<F extends FieldMap & { tick: FieldType<number> }>(fields: F): Schema<Infer<F>>;
```

Validation (throws `RangeError` with the offending name):

- `name` matches `NAME_PATTERN`; for messages it must not equal a core message name (`Hello`, `Ready`, … case-sensitive).
- `direction ∈ {'c2s','s2c','both'}`.
- `fields` passes `f.struct` validation. Empty is allowed.
- `defineEvent`: `replicate` defaults to `false`. Non-replicated events never appear on the wire but still receive ids (section 7.1) so the sim's `EventBus` (docs/sim.md) uses one id space.
- `defineInput`: `fields.tick` must be `f.u32` (`kind === 'u32'`) and must be the **first** declared field. Any other field may follow. The returned schema is used as `RegistryInput.input` and as the element type of `inputMessageSchema`.
- Definitions are immutable and registry-independent; ids/kinds are looked up through `SchemaRegistry`, so the same def can be registered in several registries (tests).

## 11. Files

### packages/protocol/src

| File | Exports |
| --- | --- |
| `index.ts` | re-exports everything below |
| `constants.ts` | every constant in section 1 |
| `errors.ts` | `DecodeError`, `DecodeErrorCode`, `EncodeError`, `EncodeErrorCode` |
| `bytes.ts` | `ByteWriter`, `ByteReader` |
| `utf8.ts` | `utf8Encode(s): Uint8Array`, `utf8Decode(bytes): string` (shared `TextEncoder`/`TextDecoder('utf-8', {fatal:true, ignoreBOM:true})` singletons), `utf8Length(s)` |
| `quant.ts` | `packQuat(q): number`, `unpackQuat(u32, out): Quat`, `encodeAngle16(rad): number`, `decodeAngle16(u16): number`, `quantize(v, scale, min, max): number` |
| `fields.ts` | `f`, `FieldType`, `FieldKind`, `FieldMap`, `NumericFieldType`, `Infer`, `EntityId`, `ENTITY_NONE` |
| `schema.ts` | `Schema`, `defineSchema`, `encodeWith`, `decodeWith`, `decodeInto`, `fieldMaskBytes`, `encodeFields`, `decodeFields` |
| `hash.ts` | `fnv1a32` (re-export of `@conduit/math`), `descriptorOf(type)` |
| `registry.ts` | `SchemaRegistry`, `RegistryInput`, `ComponentLike`, `MessageDef`, `EventDef`, `MessageDirection`, `InputFrameBase` |
| `envelope.ts` | `FrameWriter`, `readFrame`, `MessageHeader`, `seqAfter`, `nextSeq(seq)` |
| `messages.ts` | `CoreKind`, `CORE_MESSAGES`, `HelloSchema`, `WelcomeSchema`, `RejectedSchema`, `RejectReason`, `SessionStateSchema`, `PlayerEntrySchema`, `PlayerState`, `ReadySchema`, `LeaveSchema`, `SpawnedSchema`, `inputMessageSchema`, `INPUT_FRAMES_PER_MESSAGE`, `InputPayload`, `AckSchema`, `PingSchema`, `PongSchema`, `REGION_ID_MAX`, `REGION_LIST_MAX`, `RegionSetSchema`, `RegionLoadStateSchema`, `KickedSchema`, `KickReason`, and the `Infer`ed payload types (`HelloPayload`, `WelcomePayload`, `RejectedPayload`, `PlayerEntryPayload`, `SessionStatePayload`, `ReadyPayload`, `LeavePayload`, `SpawnedPayload`, `AckPayload`, `PingPayload`, `PongPayload`, `RegionSetPayload`, `RegionLoadStatePayload`, `KickedPayload`) |
| `snapshot.ts` | `SNAPSHOT_FLAG_FULL`, `SNAPSHOT_FLAG_MASKED`, `SnapshotHeader`, `SnapshotComponent`, `SnapshotCreate`, `SnapshotUpdate`, `SnapshotData`, `encodeSnapshot`, `decodeSnapshot`, `writeSnapshotHeader`, `readSnapshotHeader` |
| `events.ts` | `WireEvent`, `EventsData`, `encodeEvents`, `decodeEvents` |
| `define.ts` | `defineMessage`, `defineEvent`, `defineInput`, `assertName(name)` |

### packages/protocol/test

| File | Must prove |
| --- | --- |
| `bytes.test.ts` | every writer/reader method round-trips at boundaries (0, max, min, −1 rejected); growth from 16 bytes to 1 MB keeps contents; `MAX_WRITER_BYTES` overflow throws `capacity`; `patchU16` out of range throws; every read past end throws `DecodeError('eof')` with the correct offset; `finish()` returns a copy unaffected by later writes; `varuint` 5-byte edge (`2^32−1`) and rejection of 6-byte / over-range input |
| `fields.test.ts` | seeded property round-trip (`Rng` from `@conduit/math`, 10 000 cases per kind) for every kind including nested `struct`/`array`/`optional`; fixed16/32 clamp and NaN rejection; `str` max enforced on both sides and invalid UTF-8 rejected; `bool`/`optional` flag > 1 rejected; `array` count > max rejected on decode; `create()` defaults; `copy()` deep-copies |
| `quat.test.ts` | random unit quats round-trip with `|dot| > 0.9999`; `q` and `−q` encode to the same u32; each of the four dropped-index cases; the exact bit layout for a hand-computed quaternion; degenerate zero quat encodes identity; `−512` decodes without throwing |
| `angle.test.ts` | angle16 of `0`, `π`, `2π−ε`, negative and `> 2π` inputs; `lerp` shortest arc across the `0/2π` seam; NaN rejected |
| `schema.test.ts` | `decodeInto` performs zero allocations for a non-allocating schema (assert via a counting `Object` proxy on `create()` and by asserting `allocates === false`); `decodeInto` reuses nested objects and array elements; `optional` absent → present → absent transitions; `encodeWith` truncates on error; `fieldMaskBytes` is 1 for 0, 1 and 8 fields, 2 for 9 and 16, 0 for 17; for every mask of a mixed 5-field schema `encodeFields` writes exactly the selected fields' encodings and `decodeFields` returns exactly the selected keys in declaration order (the full mask equals `encodeWith`); invalid masks (unknown bit, negative, fractional, NaN, a 17-field schema) → `EncodeError('range')` / `RangeError`; `encodeFields` truncates on error |
| `hash.test.ts` | FNV test vectors (`''`, `'a'`, `'foobar'` = `0xBF9CF968`); descriptor strings for each kind match the grammar exactly; scale `0.001` renders as `0.001`; changing any field/scale/max/order changes the schema hash |
| `registry.test.ts` | ids identical under random permutations of `components`/`messages`/`events`; game kinds start at 128; overflow limits throw; core-name collision throws; registry hash changes when a component flips `replicate`, a message changes direction, or the input schema changes; `interpolate` changes do not change the hash |
| `envelope.test.ts` | frame with 0, 1, 255 messages; 256th throws; unknown kind skipped and following message still delivered; truncated payload → `length`; wrong wire version → `version`; `message()` rollback on encoder throw leaves `count` unchanged; `seqAfter` at the wrap boundary |
| `messages.test.ts` | byte-exact fixtures (hex) for Hello, Welcome, Rejected, SessionState, Spawned, Ack, Ping, Pong, RegionSet, RegionLoadState, Kicked, empty Ready/Leave; `inputMessageSchema` with a sample input schema |
| `snapshot.test.ts` | byte-exact fixture of a snapshot with two regions, one create with two components, one update with one changed and one removed component, one destroy; round trip through a registry; unknown compId → `unknown`; bad regionIdx → `range`; empty snapshot is 19 + 1 + 2 + 2 + 2 bytes. Field masks (9.11.1): byte-exact fixture of a MASKED snapshot with a whole create, a `u8` and a `u16` mask, a zero mask, a zero-field component and a component of more than 16 fields, whose decode carries `mask` and exactly the flagged keys and re-encodes to the same bytes; a zero mask alone; the create's bytes equal the unmasked encoding and a `mask` on a create is rejected; unknown mask bits (`u8`, `u16`, zero-field) → `range` at the mask's first byte, a truncated mask → `eof`, and the same masks rejected on encode with the writer rolled back; a `mask` in an unmasked snapshot or on a wide component → `EncodeError('range')`; the same whole data encodes to a hand-derived unmasked fixture (no mask keys after decode, `mask: undefined` equals absent) and, with MASKED, to the same records behind full masks; flag bits 2–7 masked off on decode and rejected on encode |
| `events.test.ts` | round trip with two events in two regions and one global (`REGION_IDX_NONE`); non-replicated event id → `unknown` |
| `define.test.ts` | name validation; `defineInput` without a leading `u32 tick` throws; `defineEvent` default `replicate=false`; defs are reusable across two registries with different kinds |
| `purity.test.ts` | no source file under `src/` references `Date`, `Math.random`, `setTimeout`, `setInterval`, `performance`, `process`, `fetch`, or `require` (regex over file contents) |


Schema `f.f32` values must be finite and representable as finite IEEE f32. Encoding NaN/Infinity
or finite overflow (for example1e300) throws EncodeError before publication; decoding nonfinite
f32 inside a schema throws DecodeError. This stricter wire2 boundary also covers nested vectors,
arrays and structs. Low-level ByteReader.f32/ByteWriter.f32 retain their IEEE behavior. The
server additionally validates decoded network input/game payloads before gameplay queues, so
malformed numeric input rejects one client's frame instead of faulting authoritative simulation.

# @conduit/math and @conduit/sim

Implementation specification. Binding names and boundaries come from `CONCEPT.md`. Wire format,
schema DSL and `encodeWith` are in `docs/protocol.md`; sessions, input intake and snapshots are in
`docs/net.md`; the lint rule that enforces sim purity is in `docs/consuming.md`.

Both packages are isomorphic: no `node:*`, no DOM, no `three`, no wall clock.

---

## 1. @conduit/math

### 1.1 Types

```ts
export interface Vec2 { x: number; y: number }
export interface Vec3 { x: number; y: number; z: number }
export interface Quat { x: number; y: number; z: number; w: number }
```

Plain objects only. No classes, no prototypes, no hidden fields. They are the exact shapes the
protocol codec reads and writes (`docs/protocol.md`).

### 1.2 Calling convention

Every function that produces a vector or quaternion takes a trailing `out?` parameter:

- If `out` is supplied, the result is written into it and `out` is returned. No allocation.
- If `out` is omitted, a fresh object is allocated and returned.
- `out` may alias any input; implementations must read all inputs before writing.

Scalar-returning functions (`dot`, `length`, `distance`...) never allocate.

### 1.3 Constants

| Name | Value |
| --- | --- |
| `EPS` | `1e-6` |
| `PI` | `Math.PI` |
| `TAU` | `2 * Math.PI` |
| `HALF_PI` | `Math.PI / 2` |

### 1.4 `v2` namespace

```ts
export const v2 = {
  create(x = 0, y = 0): Vec2,
  copy(a: Vec2, out?: Vec2): Vec2,
  set(out: Vec2, x: number, y: number): Vec2,
  add(a, b, out?): Vec2,          // a + b
  sub(a, b, out?): Vec2,          // a - b
  scale(a, s: number, out?): Vec2,
  dot(a, b): number,
  cross(a, b): number,            // a.x*b.y - a.y*b.x
  length(a): number,
  lengthSq(a): number,
  normalize(a, out?): Vec2,       // length < EPS -> (0,0)
  lerp(a, b, t: number, out?): Vec2,   // a + (b-a)*t, t not clamped
  distance(a, b): number,
  distanceSq(a, b): number,
  equals(a, b, eps = EPS): boolean,    // |dx|<=eps && |dy|<=eps
};
```

### 1.5 `v3` namespace

Same list as `v2` with three components, plus:

```ts
cross(a, b, out?): Vec3   // (a.y*b.z - a.z*b.y, a.z*b.x - a.x*b.z, a.x*b.y - a.y*b.x)
```

`normalize` of a vector with `length < EPS` returns `(0,0,0)`.

### 1.6 `q` namespace

```ts
export const q = {
  identity(out?): Quat,                        // (0,0,0,1)
  create(x = 0, y = 0, z = 0, w = 1): Quat,
  copy(a, out?): Quat,
  set(out, x, y, z, w): Quat,
  dot(a, b): number,
  length(a): number,
  normalize(a, out?): Quat,                    // length < EPS -> identity
  conjugate(a, out?): Quat,                    // (-x,-y,-z,w); inverse for unit quats
  multiply(a, b, out?): Quat,                  // Hamilton product a*b: apply b first, then a
  slerp(a, b, t, out?): Quat,
  fromAxisAngle(axis: Vec3, rad: number, out?): Quat,   // axis must be unit length
  fromEuler(yaw: number, pitch: number, roll: number, out?): Quat,   // YXZ intrinsic
  rotateVec3(r: Quat, v: Vec3, out?: Vec3): Vec3,
  equals(a, b, eps = EPS): boolean,            // |dot(a,b)| >= 1 - eps
};
```

Exact algorithms:

```
multiply(a, b):
  x = a.w*b.x + a.x*b.w + a.y*b.z - a.z*b.y
  y = a.w*b.y - a.x*b.z + a.y*b.w + a.z*b.x
  z = a.w*b.z + a.x*b.y - a.y*b.x + a.z*b.w
  w = a.w*b.w - a.x*b.x - a.y*b.y - a.z*b.z

fromAxisAngle(axis, rad):
  s = sin(rad/2); (axis.x*s, axis.y*s, axis.z*s, cos(rad/2))

fromEuler(yaw, pitch, roll):            // yaw about +Y, pitch about +X, roll about +Z
  result = multiply(multiply(qY(yaw), qX(pitch)), qZ(roll))
  where qY(a) = (0, sin(a/2), 0, cos(a/2)), qX(a) = (sin(a/2), 0, 0, cos(a/2)), qZ(a) = (0, 0, sin(a/2), cos(a/2))
  (expand to the closed form; the test compares against the product form)

slerp(a, b, t):
  d = dot(a, b); bb = b
  if d < 0: d = -d; bb = -b                    // shortest arc
  if d > 1 - EPS: out = normalize(a + (bb - a)*t)   // nlerp fallback
  else: th = acos(d); s = sin(th)
        out = a*(sin((1-t)*th)/s) + bb*(sin(t*th)/s)

rotateVec3(r, v):
  t = 2 * cross((r.x,r.y,r.z), v)
  out = v + r.w*t + cross((r.x,r.y,r.z), t)
```

`fromEuler` matches Three.js `Euler` order `'YXZ'`, which is the convention `docs/render.md` uses.

### 1.7 Scalar helpers

```ts
export function clamp(x: number, lo: number, hi: number): number;   // min(max(x, lo), hi)
export function wrapAngle(a: number): number;                        // result in (-PI, PI]
export function lerpAngle(a: number, b: number, t: number): number;  // shortest arc
export function lerp(a: number, b: number, t: number): number;
```

```
wrapAngle(a):
  r = a - TAU * Math.floor((a + PI) / TAU)    // r in [-PI, PI)
  if r === -PI: r = PI                        // move the boundary so the range is (-PI, PI]
  return r

lerpAngle(a, b, t): return a + wrapAngle(b - a) * t
```

### 1.8 `decomposeMat4`

```ts
export function decomposeMat4(m: ArrayLike<number>, outT: Vec3, outR: Quat, outS: Vec3): void;
```

Column-major 4x4 (glTF `node.matrix` layout). `outT = (m[12], m[13], m[14])`; `outS` = column
lengths (x negated when the 3x3 determinant is negative); `outR` = quaternion of the 3x3 with columns
divided by `outS`, normalized. If any column length is below `EPS` the rotation is undefined and
`outR` is identity. `m.length < 16` throws `RangeError`. Consumed by `deriveModelMeta` in
`docs/assets.md`.

### 1.9 `Rng` (mulberry32)

```ts
export class Rng {
  constructor(seed: number);        // state = seed >>> 0
  next(): number;                   // u32 in [0, 2^32)
  float(): number;                  // [0, 1)
  int(lo: number, hi: number): number;   // inclusive both ends; throws RangeError if lo > hi
  chance(p: number): boolean;
  pick<T>(arr: readonly T[]): T | undefined;
  fork(label: string): Rng;
  state(): number;                  // current u32 state
  restore(s: number): void;         // state = s >>> 0
}
```

Exact arithmetic, bit for bit (all intermediate values are 32-bit through `| 0`, `Math.imul`, `>>>`):

```
next():
  a = (a + 0x6D2B79F5) | 0
  t = a
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t = t ^ (t + Math.imul(t ^ (t >>> 7), t | 61))
  return (t ^ (t >>> 14)) >>> 0

float():        return next() / 4294967296
int(lo, hi):    return lo + Math.floor(float() * (hi - lo + 1))
chance(p):      return float() < p
pick(arr):      return arr.length === 0 ? undefined : arr[int(0, arr.length - 1)]
fork(label):    const salt = next();                      // parent advances by one draw
                return new Rng(fnv1a32(label, salt))      // seed = FNV-1a over label with basis = salt
```

`fork` advancing the parent is deliberate: two forks with the same label in sequence produce
different streams, and both are reproducible from the parent's state.

Known-answer vector the test must assert: `new Rng(1)` yields, in order,
`next()` = `2693262067, 11749833, 2265367787, 4213581821, 4159151403`.

### 1.10 `fnv1a32`

```ts
export const FNV_BASIS = 0x811c9dc5;
export const FNV_PRIME = 0x01000193;
export function fnv1a32(input: string | Uint8Array, seed: number = FNV_BASIS): number;
export function fnv1a32u32(h: number, value: number): number;   // mixes 4 bytes little-endian
```

```
fnv1a32(input, seed):
  h = seed >>> 0
  for each byte b of input:            // strings are encoded as UTF-8 (manual encoder; ASCII fast path; lone surrogates as U+FFFD, like TextEncoder)
    h = Math.imul(h ^ b, FNV_PRIME)
  return h >>> 0

fnv1a32u32(h, v):
  for i in 0..3: h = Math.imul(h ^ ((v >>> (8*i)) & 0xff), FNV_PRIME)
  return h >>> 0
```

Known answers: `fnv1a32('')` = `0x811c9dc5`, `fnv1a32('a')` = `0xe40c292c`.
`@conduit/protocol` uses this function for schema and registry hashes.

---

## 2. @conduit/sim

### 2.1 EntityId

`EntityId` is a `number` holding a u32. The type and `ENTITY_NONE` are declared in `@conduit/protocol`
(`fields.ts`); `@conduit/sim` re-exports both and owns the slot/generation layout below.

| Constant | Value | Meaning |
| --- | --- | --- |
| `SLOT_BITS` | `20` | |
| `SLOT_MASK` | `0x000FFFFF` | |
| `GEN_SHIFT` | `20` | |
| `GEN_MASK` | `0xFFF` | 12 bits, bits 20..31 |
| `LOCAL_BIT` | `0x80000000` | bit 31 |
| `MAX_SLOTS` | `1_048_576` | `1 << 20` |
| `SERVER_GEN_WRAP` | `2048` | server generations wrap at 11 bits so bit 31 stays clear |
| `LOCAL_GEN_BASE` | `2048` | local generations are `2048 | n`, so bit 31 is set |
| `ENTITY_NONE` | `0` | re-exported from `@conduit/protocol` (`docs/protocol.md` §4.2), which owns the `EntityId` type and this constant; slot 0 is reserved and never allocated |

```ts
export function slotOf(e: EntityId): number;      // e & SLOT_MASK
export function genOf(e: EntityId): number;       // (e >>> GEN_SHIFT) & GEN_MASK
export function makeId(slot: number, gen: number): EntityId;   // (((gen & GEN_MASK) << GEN_SHIFT) | (slot & SLOT_MASK)) >>> 0
export function isLocal(e: EntityId): boolean;    // (e & LOCAL_BIT) !== 0
export { type EntityId, ENTITY_NONE } from '@conduit/protocol';
```

The 12-bit generation and the bit-31 local flag coexist because server generations wrap at
`SERVER_GEN_WRAP` (bit 31 clear) and local generations start at `LOCAL_GEN_BASE` (bit 31 set).

**Client-local allocator** (used by `@conduit/net-client` and `@conduit/render` for view-only
entities such as particles; never replicated, never persisted):

```ts
export class LocalIdAllocator {
  private nextSlot = 1; private gens: number[] = []; private free: number[] = [];   // gens: per-slot generation, 0..2047
  alloc(): EntityId;    // slot = free.pop() ?? nextSlot++; return makeId(slot, LOCAL_GEN_BASE | gens[slot])
  release(e): void;     // throws StaleEntity unless e is currently allocated here; gens[slot] = (gens[slot] + 1) % 2048; push slot to free
}
```

`World` throws `StaleEntity` for any local id passed to it.

### 2.2 World entity table

```
capacity: number           initial 1024, doubles when a slot >= capacity is needed; max MAX_SLOTS
highWater: number          highest allocated slot + 1
generation: Uint16Array    per slot, length capacity
allocated: Uint8Array      1 if slot is currently allocated
freeList: number[]         LIFO stack of released slots
pendingDestroy: number[]   entity ids queued this tick, in call order
pendingFlag: Uint8Array    1 if slot is queued (idempotent destroy)
```

```
create():
  slot = freeList.pop() ?? highWater++
  if slot >= capacity: grow(capacity*2) and notify every store via store._grow(capacity)
  allocated[slot] = 1
  return makeId(slot, generation[slot])

alive(e):
  if isLocal(e) return false
  s = slotOf(e)
  return s < highWater && allocated[s] === 1 && generation[s] === genOf(e)

destroy(e):
  if !alive(e) throw StaleEntity(e)
  if pendingFlag[slot] return
  pendingFlag[slot] = 1; pendingDestroy.push(e)

destroyedThisTick(): readonly EntityId[]     // pendingDestroy, valid until applyDestroys

applyDestroys():                              // called by Simulation.step, step 4
  for e in pendingDestroy (call order):
    for store in stores (component id order): if store.has(e): store.remove(e)   // stamps removedAt
    s = slotOf(e)
    generation[s] = (generation[s] + 1) % SERVER_GEN_WRAP
    allocated[s] = 0; pendingFlag[s] = 0
    freeList.push(s)
  pendingDestroy.length = 0
```

Entities queued for destroy are `alive()` and present in stores until `applyDestroys`. The free
list is LIFO: slot reuse is immediate and deterministic; the generation bump makes stale ids fail
`alive()`.

### 2.3 `ComponentStore<T>`

Sparse-set layout:

```
dense: Uint32Array      entity ids, unordered (swap-remove), capacity doubles
values: T[]             parallel to dense
sparse: Int32Array      slot -> dense index, -1 when absent; length = world.capacity
version: Uint32Array    per slot; tick of last write while present (monotonic while present); 0 when absent
removedAt: Uint32Array  per slot; tick of last remove; monotonic, never cleared
size: number
order: Uint32Array | null   copy of dense sorted by slot, rebuilt lazily
orderDirty: boolean
```

```ts
export class ComponentStore<T> {
  readonly type: ComponentType<T>;
  readonly version: Uint32Array;
  readonly removedAt: Uint32Array;
  get size(): number;
  has(e: EntityId): boolean;
  read(e: EntityId): DeepReadonly<T>;
  tryRead(e: EntityId): DeepReadonly<T> | undefined;
  write(e: EntityId): T;
  set(e: EntityId, v: DeepReadonly<T>): void;
  add(e: EntityId, v?: Partial<T>): T;
  remove(e: EntityId): boolean;
  entities(): Iterable<EntityId>;
  entitiesArray(): Uint32Array;     // the sorted order array; do not mutate; valid until next mutation
  clear(): void;
  _grow(capacity: number): void;    // called by World only
}
```

Exact semantics (`tick` = the stamp tick: `world.tick` while `world.stepping`, i.e. inside
`Simulation.step`, else `world.tick + 1`; see the note on stamps below). Every op except `has` and
`tryRead` first throws `StaleEntity(e)` if `!world.alive(e)` (local ids included); `has` is then
`false` and `tryRead` `undefined`.

| Op | Behaviour |
| --- | --- |
| `has(e)` | `world.alive(e) && sparse[slot] >= 0` |
| `read(e)` | returns the live object typed `DeepReadonly<T>`; no stamp; throws `MissingComponent(type.name, e)` if absent |
| `tryRead(e)` | as `read` but returns `undefined` if absent |
| `mutate(e, update)` | stamps a write, calls a synchronous callback with mutable access, then validates finite values; `World.mutate(e, type, update)` delegates to it |
| `write(e)` | `version[slot] = tick`; returns the live object; throws if absent |
| `set(e, v)` | `type.copy(values[i], v)` (schema-driven deep copy of every field); `version[slot] = tick`; throws if absent |
| `add(e, v?)` | throws `AlreadyPresent` if present, `StaleEntity` if `!alive`; `obj = type.create()`; for each field name `k` in declaration order that is an own key of `v`: `type.copyField(k, obj, v)` (by value; nested vec/struct copied, never referenced; `undefined` for a non-optional field is skipped; keys that are not fields are ignored); append to `dense`/`values`; `sparse[slot] = size++`; `version[slot] = tick`; `orderDirty = true`; `removedAt` untouched; returns `obj` |
| `remove(e)` | returns `false` if absent; `i = sparse[slot]`; `last = size-1`; if `i !== last`: `dense[i] = dense[last]; values[i] = values[last]; sparse[slotOf(dense[i])] = i`; `values.pop()`-equivalent (`values.length = last`); `size--`; `sparse[slot] = -1`; `removedAt[slot] = tick`; `version[slot] = 0`; `orderDirty = true`; returns `true` |
| `entities()` | ascending slot order; see below |
| `clear()` | removes every entity (stamps each) |

Note on `version`: it is monotonic while the component is present. On `remove` it is set to 0 so
that a re-`add` stamps a fresh tick (`add` always stamps `version[slot] = tick`, so a remove followed
by a re-add in a later tick yields `version > baselineTick` and is reported as changed). The
monotonic, never-cleared stamp is `removedAt`. The snapshot builder (`docs/net.md` A.8) derives:
"changed since baseline" = `has(e) && version[slot] > baselineTick`;
"removed since baseline" = `!has(e) && removedAt[slot] > baselineTick`.
`version` is only ever read behind a `has(e)` check, so its value while absent is never observed.
`version`, `removedAt` and `sparse` are reallocated when the World grows: read them through the store.

Note on the stamp tick: writes between steps (Session lifecycle and hooks, `hooks.onMessage`,
`regions.update`, `onInit`/`onLoad`; `docs/net.md` A.5) run while `world.tick === T - 1` for the
coming step `T`. Stamped `T - 1`, they would equal the baseline of a snapshot built after step
`T - 1` and `version > baselineTick` would never report them; they are stamped `T`, the tick they
belong to. `Simulation.step` sets `world.stepping` (2.9).

**`entities()` ordering.** `dense` is unordered because `remove` is a swap-remove. Decision:
maintain `order`, a copy of `dense[0..size)` sorted by ascending slot, rebuilt when `orderDirty` at
the start of `entities()`/`entitiesArray()`; the rebuild allocates a new `Uint32Array(size)`, fills
it with the slots of `dense[0..size)`, sorts it with a numeric comparator, and maps each slot back
to its id through `sparse` (slots are unique within a store; sorting the ids themselves would order
by generation first once slots are reused). Rationale: cost is `O(n log n)` per mutation batch over
this store's `n`, not over world capacity; a store with 3 entities in a world with 50 000 slots
costs nothing to iterate, whereas scanning `sparse` up to `highWater` would cost 50 000 probes per
query. Iterators keep a reference to the array they started on, so a mutation during iteration
(which allocates a new `order`) never disturbs an in-flight loop: adds during iteration are not
visited; removes are hidden because `World.query` re-probes `has` before yielding.

Component reads use exported `DeepReadonly<T>`, recursively including arrays, vectors, structs and
optional fields. Enable development guards with `new World(registry, { mutationGuards: true })`.
Readonly proxies are cached and reflect later tracked mutations without freezing backing data.
`mutate` access expires when its synchronous callback returns, including nested references; guarded
object assignments copy values so caller-owned aliases cannot mutate the world later. Legacy `write`
and `add` references must be discarded before the tick changes and reacquired for each tracked write.
Guards detect expired legacy references; production callers must honor the same contract themselves.
Non-finite numbers are rejected at add/set/mutate boundaries and at tick commit for legacy writes,
with a component and field path. Game-specific ranges remain the game's responsibility.

### 2.4 `defineComponent`

```ts
export interface ComponentOpts { replicate?: boolean; persist?: boolean; interpolate?: string[]; extrapolateWith?: string }

export interface ComponentType<T> {
  readonly name: string;
  readonly schema: Schema<T>;          // protocol defineSchema(fields)
  readonly fields: FieldMap;           // frozen copied field declarations, for tooling
  readonly replicate: boolean;         // default true
  readonly persist: boolean;           // default false
  readonly interpolate: readonly string[];   // default []
  readonly extrapolateWith?: string;   // default undefined
  create(): T;                         // schema defaults: numbers 0, bool false, str '', vec zero, quat identity, array [], optional undefined, entity ENTITY_NONE, struct recursively
  copy(dst: T, src: DeepReadonly<T>): T;   // deep copy of every field
  copyField(key: keyof T, dst: T, src: Partial<T>): void;
}

export function defineComponent<F extends FieldMap>(name: string, fields: F, opts?: ComponentOpts): ComponentType<Infer<F>>;
export function buildCreate<T>(schema: Schema<T>): () => T;                          // also used by defineEvent
export function buildCopy<T>(schema: Schema<T>): (dst: T, src: DeepReadonly<T>) => T;
```

`create`, `copy` and `copyField` are generated once by walking the field spec kinds
(`docs/protocol.md`): scalars assign, `vec2/vec3/quat/struct` recurse into existing objects,
`array` copies length then elements, `optional` copies `undefined` or recurses, `str` assigns.
`defineComponent` rejects a `name` that fails `NAME_PATTERN` (`RangeError`, as protocol's `define*` do).
The rest is validated at `defineGame` (`docs/game.md`): unique, `interpolate` names must be fields
of kind `vec2 | vec3 | quat | angle16 | f32 | fixed16 | fixed32`, `extrapolateWith` must name a
vec field of the same arity as the first `interpolate` vec field.

### 2.5 Core components

```ts
export const Transform = defineComponent('Transform',
  { pos: f.vec3(f.fixed32(0.001)), rot: f.quat(), vel: f.vec3(f.f32) },
  { replicate: true, persist: true, interpolate: ['pos', 'rot'], extrapolateWith: 'vel' });

export const Region = defineComponent('Region', { id: f.str(64) }, { replicate: true, persist: false });
export const Model  = defineComponent('Model',  { asset: f.str(64), variant: f.u8 }, { replicate: true, persist: true });
export const Owner  = defineComponent('Owner',  { player: f.u8 }, { replicate: true, persist: false });
export const Name   = defineComponent('Name',   { value: f.str(32) }, { replicate: true, persist: true });

export const CORE_COMPONENTS = [Transform, Region, Model, Owner, Name] as const;
```

`persist` decisions: a saved entity is useless without its position, model and name, so those
persist. `Region.id` is re-derived from the blob it is stored in. `Owner` marks player-owned
entities; players are never written into region blobs (`docs/world.md` section 6).

`Transform.pos` is region-local (`docs/world.md` section 4). `fixed32(0.001)` gives a range of
±2 147 483 m per axis. `Transform.vel` is `f32`, m/s, and has no cap. As `fixed16(0.01)` it
stopped at ±327.67 m/s per axis, short of a supersonic aircraft, and a game cannot put a wider
velocity of its own in its place: `extrapolateWith` and every reader of the core `Transform` use
this one. It costs 6 bytes more per moved entity (PLAN.md Spike 1). Games override per component
by defining their own.

### 2.6 World

```ts
export class World {
  tick: number;                       // 0 until the first step
  stepping: boolean;                  // true while Simulation.step runs (set by Simulation); selects the stamp tick (2.3)
  readonly registry: SchemaRegistry;  // docs/protocol.md
  constructor(registry: SchemaRegistry, opts?: { capacity?: number });   // creates every store eagerly, in component id order; definitions remain immutable; IDs are registry-local
  create(): EntityId;
  destroy(e: EntityId): void;          // deferred, see 2.2
  alive(e: EntityId): boolean;
  destroyedThisTick(): readonly EntityId[];
  applyDestroys(): void;
  store<T>(c: ComponentType<T>): ComponentStore<T>;   // by registry-local identity/validated structural equivalence; throws UnknownComponent if unknown or conflicting
  stores(): readonly ComponentStore<unknown>[];        // component id order
  add<T>(e, c, v?: Partial<T>): T;
  get<T>(e, c): DeepReadonly<T>;
  tryGet<T>(e, c): DeepReadonly<T> | undefined;
  write<T>(e, c): T;
  has(e, c): boolean;
  remove(e, c): boolean;
  query(...cs: ComponentType<unknown>[]): Iterable<EntityId>;
  queryInto(out: EntityId[], ...cs: ComponentType<unknown>[]): EntityId[];   // allocation-free; out.length reset to 0 first
  count(): number;                     // allocated entities
  hash(): number;
}
```

```
query(...cs):
  if cs.length === 0: yield every slot s in [1, highWater) with allocated[s] === 1, as makeId(s, generation[s])   // the list is taken when iteration starts
  primary = the store with the smallest size; ties -> lowest component id
  for e of primary.entities():
    if every store in cs has(e): yield e          // includes primary: hides entities removed mid-iteration
```

```
hash():
  h = FNV_BASIS
  w = the World's single reusable ByteWriter; 
  for (id, store) in stores() where store.type.replicate (component id order):
    h = fnv1a32u32(h, id)                           // the store's index in stores() (= world.registry.componentId(store.type))
    h = fnv1a32u32(h, store.size)
    for e of store.entities():                      // ascending slot order
      h = fnv1a32u32(h, e)
      w.reset(); encodeWith(w, store.type.schema, store.read(e))
      h = fnv1a32(w.view(), h)                      // view() is a subarray over the writer; no copy (docs/protocol.md §3)
  return h
```

Hashing the encoded bytes means the hash follows the schema's quantization, so two machines that
differ only in sub-quantum float noise still agree, and any schema change changes the hash.

### 2.7 Systems and phases

```ts
export type Phase = 'input' | 'preSim' | 'sim' | 'postSim';
export const PHASES: readonly Phase[] = ['input', 'preSim', 'sim', 'postSim'];
export interface System { readonly name: string; readonly phase: Phase; run(ctx: SimContext): void }
export function defineSystem(name: string, phase: Phase, run: (ctx: SimContext) => void): System;
```

Execution order: `PHASES` order, then registration order within a phase. `Simulation.register`
throws `DuplicateSystem` on a repeated name and `Error` if called after the first `step`.

Rule: a system holds no cross-tick state outside components. Module-level constants are fine;
module-level mutable caches, closures over counters and `WeakMap`s keyed by entity are not.
Per-tick scratch buffers must be reset at the start of `run`.

### 2.8 SimContext and EventBus

```ts
export interface SimContext {
  readonly world: World;
  readonly tick: number;
  readonly dt: number;                       // 1 / tickRate seconds
  readonly rng: Rng;                         // world stream, seeded from game.seed
  regionRng(id: RegionId): Rng;              // per-region stream (docs/world.md section 7)
  readonly regions: RegionsApi;
  readonly spatial: SpatialApi;
  readonly events: EventBus;
  inputs(player: number): InputFrame | undefined;
}
```

`RegionsApi` and `SpatialApi` are structural interfaces declared in sim so the dependency stays
`sim <- world`; `@conduit/world`'s `RegionManager` and `SpatialIndex` implement them:

```ts
export interface RegionsApi {
  regionOf(e: EntityId): RegionId | undefined;
  entitiesIn(id: RegionId): readonly EntityId[];     // ascending id order
  active(): readonly RegionId[];                     // sorted
  def(id: RegionId): RegionDefLike | undefined;      // { id, kind, bounds, seed, data? }
  migrate(e: EntityId, to: RegionId, newLocalPos?: Vec3): string;
}
export interface SpatialApi {
  queryRadius(regionId: RegionId, pos: Vec3, r: number, out: EntityId[]): EntityId[];
  queryAABB(regionId: RegionId, min: Vec3, max: Vec3, out: EntityId[]): EntityId[];
  queryRadiusAcross(regionId: RegionId, pos: Vec3, r: number, out: EntityId[], outRegions?: RegionId[]): EntityId[];
  nearest(regionId: RegionId, pos: Vec3, maxR: number, exclude?: EntityId): EntityId | undefined;
}
```

**Events**

```ts
export interface EventOpts { replicate?: boolean }        // default true
export interface EventType<T> { readonly name: string; readonly schema: Schema<T>; readonly replicate: boolean; create(): T; copy(dst: T, src: T): T }
export function defineEvent<F extends FieldMap>(name: string, fields: F, opts?: EventOpts): EventType<Infer<F>>;   // name checked against NAME_PATTERN

export interface Emitted<T> { readonly tick: number; readonly regionId: RegionId | undefined; readonly payload: DeepReadonly<T> }
export interface ReplicatedEvent { typeId: number; tick: number; regionId: RegionId | undefined; payload: unknown }

export class EventBus {
  constructor(world: { readonly tick: number; readonly registry: SchemaRegistry });   // Simulation passes its World; one list per registry event, definitions remain immutable; IDs are registry-local
  emit<T>(type: EventType<T>, payload: T, regionId?: RegionId): void;
  consume<T>(type: EventType<T>): ReadonlyArray<Emitted<T>>;
  endTick(): void;
  drainOutbox(): ReplicatedEvent[];
  readonly droppedEvents: number;
}
export const MAX_OUTBOX = 4096;
```

Core local event: `RegionChanged = defineEvent('RegionChanged', { entity: f.entity(), from: f.str(64), to: f.str(64) }, { replicate: false })`.

Semantics:

- `emit` copies `payload` by value (`type.copy(type.create(), payload)`) and appends
  `{ tick, regionId, payload }` to `perType[registry.eventId(type)]`, in emit order; `tick` is `world.tick`.
  `emit`/`consume` of an event that is not in the registry throw `RangeError`.
- `consume(type)` returns the array for this tick: everything emitted earlier in the same tick,
  including earlier in the same phase and earlier in the same system. It does not remove entries;
  every consumer sees the same list.
- `endTick()` (pipeline step 5): for each type with `replicate === true`, append its entries to
  `outbox` as `ReplicatedEvent` (type id order, then emit order); if `outbox.length > MAX_OUTBOX`
  drop the oldest and increment `droppedEvents`. Then clear every per-type array in place (local
  and replicated alike).
- `drainOutbox()` returns the outbox and replaces it with an empty array. The Session
  (`docs/net.md`) calls it after every `step`; events keep their `tick` so clients can schedule
  them against `renderTick`.

### 2.9 Simulation and the tick pipeline

```ts
export interface SimulationOpts {
  world: World;
  tickRate?: number;                     // default 60
  seed: number;                          // ctx.rng = new Rng(seed)
  regionRng: (id: RegionId) => Rng;
  regions: RegionsApi;
  spatial: SpatialApi;
  maxPlayers?: number;                   // default MAX_PLAYERS = 8
}
export const MAX_PLAYERS = 8;

export class Simulation {
  readonly ctx: SimContext;
  readonly events: EventBus;
  readonly inputFrames: (InputFrame | undefined)[];       // indexed by player id; written by the caller
  readonly tail: Array<(ctx: SimContext) => void>;         // core postSim tail, pushed by the caller
  constructor(opts: SimulationOpts);
  register(system: System): void;
  systems(phase: Phase): readonly System[];
  step(tick: number): void;
  skip(count: number): void;                               // world.tick += count without a step: the ticks a Session's loop drops (2.10)
  onInputsPlaced?: ((tick: number, player: number, frame: InputFrame | undefined) => void) | undefined;   // replay recording hook: step reports every player's frame, see 2.11
}
```

Canonical tick pipeline. `docs/net.md`, `docs/world.md` and CONCEPT.md refer to this list; it is
not restated there. The Session's per-tick sequence is, in order: (a) lifecycle and input intake
(Session-owned, `docs/net.md` A.5), (b) the game's simulation interest, then
`regions.update(players, ctx, pending, interest)` (`docs/world.md` 5.2), (c) `simulation.step(tick)`
below, (d) `events.drainOutbox()` into per-client event queues, (e) on snapshot ticks, RegionSet refresh and snapshot build (`docs/net.md` A.8). Snapshots are
therefore built after destroys have been applied and after `endTick`, so the snapshot for tick
`T` already carries the destroys of tick `T`.

```
step(tick):
  0. precondition: tick === world.tick + 1, else throw TickOrder (and Error if world.stepping: not re-entrant)
  1. world.tick = tick; ctx.tick = tick; ctx.dt = 1 / tickRate; world.stepping = true
     (inputs for this tick were already written into inputFrames by the caller)
     // input recording is deferred until successful completion (2.11)
  2. for phase of PHASES: for sys of systems[phase] (registration order): sys.run(ctx)
  3. for fn of tail: fn(ctx)
     the Session pushes, in this order: regions.membershipSystem.run, spatial.rebuild  (docs/world.md)
  4. world.applyDestroys()
  5. events.endTick()
  finally: world.stepping = false
```

If a system or tail throws, `step` throws a `SimulationFault` with `tick`, `system`, `phase`, and
`cause`. The simulation remains faulted and rejects later steps. Partial component state and queued
destroys remain available for diagnostics; they are not a checkpoint. Recovery requires restoring a
complete prior checkpoint, including RNG and game state. Input recording runs after successful phases
and tail, so failed ticks do not commit input history. The Session also buffers outbound frames until
the authoritative pipeline succeeds, closes clients with terminal code 4012 on failure, stops admission,
and refuses persistence capture. A save captured before a fault may finish; fault shutdown never
captures the partial world. Relevance callbacks remain isolated to one client's snapshot. Lifecycle,
message and world-edge callbacks may mutate authoritative state and fault the session when they throw.

`skip(count)` (an integer >= 1, `RangeError` otherwise; `Error` while stepping) moves `world.tick`
and `ctx.tick` on by `count` without a step: no phase, no tail, no `onInputsPlaced`, so none of
those ticks runs. It closes registration as the first step does. A Session skips the ticks its loop
drops (2.10), and a replay of it the same ones (2.11). What was written or emitted between steps
keeps its stamp (`tick + 1` for a write, `tick` for an event) and reaches the next step as it would
have.

Outside `step`, before it, the Session runs `regions.update(players, ctx, pending, interest)`
(`docs/world.md` section 5) so region activation always lands on a tick boundary; it runs every tick, not only on
snapshot ticks. Sim never clears `inputFrames`;
the "hold last frame" policy is the Session's (`docs/net.md`).

### 2.10 FixedLoop

Lives in sim (no timers are used by the sim itself; the loop is the *driver* the Session uses).

```ts
export interface FixedLoopOpts {
  tickRate: number;
  onTick(tick: number): void;
  onOverrun(droppedTicks: number): void;
  now?: (() => number) | undefined;                                  // default performance.now
  setTimeout?: ((fn: () => void, ms: number) => unknown) | undefined; // default: the compensated Node timers below
  clearTimeout?: ((h: unknown) => void) | undefined;                  // default: cancels a default timer (or a globalThis.setTimeout handle)
  maxCatchUpTicks?: number | undefined;                              // default MAX_CATCH_UP_TICKS
  // `| undefined` so the Session can pass `now: opts.now` straight through (docs/net.md A.4)
}
export const MAX_CATCH_UP_TICKS = 5;

export class FixedLoop {
  constructor(opts: FixedLoopOpts);
  start(): void; stop(): void;
  readonly running: boolean; readonly tick: number;
  stats(): { wakes: number; ticks: number; overruns: number; droppedTicks: number; maxTicksPerWake: number; lastLateMs: number };
}
```

```
tickMs = 1000 / tickRate

start():
  if running return
  running = true; tick = 0
  nextDeadline = now() + tickMs
  arm()

arm():
  timer = setTimeout(wake, max(0, nextDeadline - now()))

wake():
  if !running return
  t = now(); n = 0
  lastLateMs = t - nextDeadline                           // lateness vs. the armed deadline; negative for an early wake
  while nextDeadline <= t and n < maxCatchUpTicks:
    n++; nextDeadline += tickMs
  wakes++; maxTicksPerWake = max(maxTicksPerWake, n)
  if nextDeadline <= t:                                   // still behind after the cap
    dropped = floor((t - nextDeadline) / tickMs) + 1      // the ticks due before the last n
    nextDeadline += dropped × tickMs                      // the first deadline after t: still on the grid
    tick += dropped                                       // their numbers skipped
    overruns++; droppedTicks += dropped
    onOverrun(dropped)                                    // before the n ticks, the latest due, run
  repeat n times while running: tick++; ticks++; onTick(tick)
  if running: arm()                                       // also when onTick/onOverrun throws (try/finally)

stop():
  running = false; clearTimeout(timer)
```

The default timers (one `lead` per `FixedLoop`; the callback never runs before `ms` have elapsed):

```
POLL_BELOW_MS = 1; lead = 1                               // lead is clamped to [0, 4] ms

setTimeout(fn, ms):
  due = performance.now() + ms; first = true
  wait(ms)

wait(left):
  if left < POLL_BELOW_MS:                                // a Node timer cannot wait less than 1 ms
    setImmediate(check); return
  k = max(1, round(left - lead))                          // whole ms, armed lead ms early
  armedAt = performance.now(); learnThis = first; first = false
  Node setTimeout(k): if learnThis: learn(performance.now() - armedAt - k); check()

check():
  left = due - performance.now()
  if left <= 0: fn() else wait(left)

learn(overshoot):                                         // only the first timer of a wait; later ones are short
  lead = clamp(lead + (overshoot > lead ? 0.15 : -0.05), 0, 4)   // settles on the 75th percentile

clearTimeout(h):
  clear h's pending Node timeout or immediate             // any other handle: globalThis.clearTimeout(h)
```

A wake belongs to the `start()` that armed it: `stop()` from inside `onTick` runs no further tick
of that wake and does not re-arm, and a `stop(); start()` there does not leave two timer chains.

The deadline is absolute, so timer lateness does not accumulate. An early wake (`t < nextDeadline`)
yields `n = 0` and re-arms for the remainder.

A loop held up -- a long GC, the process swapped out or descheduled -- wakes with more ticks due
than it may run. It runs the latest `maxCatchUpTicks` and drops the ones before them, skipping their
numbers, with the deadlines left on their grid: tick `k` is due at `start + k × tickMs` for as long
as the loop runs, and never starts earlier. The Session skips the dropped ticks in its world too
(`docs/net.md` A.4). Clients rely on this: they map ticks onto the server's clock by the earliest
tick start seen (the tick epoch, `docs/net.md` B.4). Until 2026-10 the loop resynced to `t + tickMs`
and numbered on from where it stopped, so every tick after a stall lagged the clock by the stall for
good: clients drew ahead of the snapshots they had until their window of clock samples moved on,
then jumped back, and sent their inputs for ticks that far ahead, which the server queued while the
player's entity kept its last input. Measured with a game's dev server held up 300 ms: a 0.1 s
freeze, a lurch, 0.65 s at three times the speed, then a jump back of 12 ticks. Injected timers may fire early (the virtual-clock tests
make them do so); the default timers never do, so with them every wake runs a tick.

Why the default timers are not plain `globalThis.setTimeout`: with it, Spike 2a measured p50 1.3 ms
and p99 2.1 ms lateness on macOS whether the machine was idle or loaded. The cause is the timer, not
load or a stale loop time (a 2-5 ms busy body before arming changed nothing): Node truncates the
delay to whole milliseconds, and a `k` ms sleep then ends about `min(k / 4, 2)` ms late (consistent
with macOS timer coalescing), so every 12-15 ms re-arm landed 1-2 ms late. The 13% of wakes that
came early were timers coalesced with other wakeups; their sub-millisecond re-arm became a 1 ms timer
that landed 1.3 ms later, but finishing only those remainders with `setImmediate` still left p99 at
2.07 ms. Arming early by the learned overshoot fixes the bulk; rounding to the nearest ms then leaves
about half the timers up to 0.5 ms early, and those remainders are polled. A timer still 1 ms or
more early hops onto another Node timer instead, because polling burns CPU (on Linux a zero-timeout
poll never sleeps): polling every early arrival gave the same p99 at about 0.5% of a core more. Over
seven 60 s samples at 60 Hz on macOS the default timers gave p50 0.02 ms and p99 0.54-0.92 ms
(median 0.60), costing 1.25% of one core for an empty-body loop (0.55% before) and about 1.2% on
top of a 2 ms body (0.5% before). Linux timers carry about 50 µs of slack, so there `lead` should
settle near 0.1 ms and the cost should be mostly the rounding polls, about 0.125 ms per tick
(estimated; only macOS was measured).

Required test (`fixedLoop.test.ts`): inject a virtual clock and a timer queue; `onTick` advances
the clock by 2 ms (synthetic body); advance the virtual clock through 60 000 ms draining timers in
deadline order; assert ticks in `[3599, 3601]` and `overruns === 0`. Second case: body of 20 ms at
60 Hz; assert every wake runs at most 5 ticks and `droppedTicks > 0`. Another stalls the virtual
clock 300 ms after tick 60: the wake runs ticks 74 to 78, `onOverrun(13)` comes before them, and
every tick starts at or after its deadline (and, after the stall, within a tick of it). A third, real-timer case
runs about 2 s on every `pnpm test` on the default clock and timers with a loose bound (at least 60
ticks, never ahead of the wall clock, no wake without a tick), because shared CI machines delay
timers. Spike 2a (PLAN.md M1) is a fourth case that runs only with `CONDUIT_SLOW=1`: 10 minutes
(`CONDUIT_SLOW_SECONDS` overrides the length for sampling) of the default timers with a 2 ms busy
body, `stats().lastLateMs` sampled at the first tick of every wake into a 64-bucket histogram
(0.25 ms buckets), printing p50/p99/max, early wakes, `droppedTicks` and CPU use as a percentage of
one core, and asserting p99 `< 2 ms` and no drops. It measures through `onTick` rather than wrapped
timers so that it exercises the default timers the Session uses.

### 2.11 Replay

A replay feeds a recorded log into a fresh run of a game and compares state hashes at checkpoints:
same seed, same inputs and same lifecycle give the same hashes, so it serves as a regression test.
Inputs alone do not rebuild a session's world (players join, spawn and leave at ticks their clients
decide), so a log also carries the Session's lifecycle steps, and the ticks its loop dropped (2.10),
which never ran and which a replay skips too.

```ts
export type LifecycleEvent =                       // one player's Session lifecycle step (docs/net.md A.6)
  | { type: 'join'; accountId: string; displayName: string }   // onPlayerJoin ran
  | { type: 'spawn' }                              // the player was ready: PlayerSpawn.spawn runs once the planned region is active
  | { type: 'leave' };                             // the leave ran: onPlayerLeave (if the join ran), entity destroyed, slot freed
export type InputLogEntry = [tick: number, playerId: number, frame: InputFrame | null];   // null: from this tick the player has no frame
export type LifecycleEntry = [tick: number, playerId: number, event: LifecycleEvent];
export type SkipEntry = [tick: number, count: number];   // ticks tick .. tick + count - 1 never ran

export interface InputLog {                        // plain data; round-trips through JSON
  version: 1;
  seed: number;
  tickRate: number;
  entries: InputLogEntry[];                        // sorted by tick, then playerId
  lifecycle?: LifecycleEntry[];                    // ascending tick; within a tick in the order they ran
  skips?: SkipEntry[];                             // ascending, not overlapping, over no tick an entry or a lifecycle step names
}
export type Checkpoint = [tick: number, hash: number];
export type ReplayResult = { ok: true } | { ok: false; tick: number; expected: number; actual: number };

export interface ReplayRun {
  setInput(player: number, frame: InputFrame | null): void;   // placed for the next step and held after it; null: none
  lifecycle?(player: number, event: LifecycleEvent): void;    // for the next step; required when the log has lifecycle entries
  skip?(count: number): void;                                  // moves on count ticks without a step; required when the log has skips
  step(tick: number): Promise<void>;        // async so MemoryStore-backed region loads settle on the same tick boundary
  hash(): number;
}
export interface ReplayableGame { createRun(seed: number, tickRate: number): Promise<ReplayRun> }

export function recordInputs(sim: Simulation, log: InputLog): () => void;   // installs sim.onInputsPlaced; returns uninstall
export async function record(game: ReplayableGame, log: InputLog, every: number): Promise<Checkpoint[]>;
export async function replay(game: ReplayableGame, log: InputLog, checkpoints: readonly Checkpoint[]): Promise<ReplayResult>;
```

```
recordInputs(sim, log):                     // install before the first step: a log describes a run from tick 1
  last[p] = none for every player
  sim.onInputsPlaced = (tick, p, frame) =>  // step reports every player's frame after successful execution (2.9)
    bytes = frame === undefined ? none : encode(frame, world.registry.input)
    if bytes equals last[p]: skip           // a held frame, or equal bytes
    else: last[p] = bytes; insert [tick, p, bytes === none ? null : decode(bytes)] after the entries sorting at or before it
    then call the hook that was installed before, if any
  uninstall(): stop recording; if sim.onInputsPlaced is still this hook, restore the previous one

feed(run, tick):                            // record and replay, before each step
  for lifecycle entries of tick, in log order: run.lifecycle(playerId, event)
  for entries of tick, in log order: run.setInput(playerId, frame)

skip(run, tick):                            // record and replay, before each tick: the next tick that runs
  while a skip [tick, count] starts at tick: run.skip(count); tick += count
  return tick

record(game, log, every):                   // every: integer >= 1
  run = await game.createRun(log.seed, log.tickRate)
  last = the log's last tick (entries, lifecycle and skips); for an empty log, no tick runs
  for tick = skip(run, 1); ; tick = skip(run, tick + 1):
    feed(run, tick); await run.step(tick)
    if tick % every === 0: checkpoints.push([tick, run.hash()]); if tick >= last: stop   // a skipped tick takes none
  return checkpoints

replay(game, log, checkpoints):
  run = await game.createRun(log.seed, log.tickRate)
  lastTick = max(the log's last tick, last checkpoint tick)
  for tick = skip(run, 1); tick <= lastTick; tick = skip(run, tick + 1):
    feed(run, tick)
    await run.step(tick)                  // caller's run also invokes regions.update before sim.step
    for each checkpoint of tick (checkpoints sorted by tick): if run.hash() !== expected: return { ok: false, tick, expected, actual }
  return { ok: true }
```

`record` and `replay` validate before creating a run: `RangeError` for a log that is not version 1,
a `seed` that is not a u32, a `tickRate` that is not positive, entries out of order or not
`[tick >= 1, playerId >= 0, object | null]`, lifecycle entries out of tick order or with an unknown
event, a checkpoint that is not `[tick >= 1, number]`, and an `every` that is not an integer >= 1;
skips that are not `[tick >= 1, count >= 1]`, out of order or overlapping, or over a tick an entry or
a lifecycle step names; and a checkpoint at a skipped tick. Once the run exists, a log with
lifecycle entries and a run without `lifecycle`, or skips and a run without `skip`, is a
`TypeError`.

Frames are compared and stored in their encoded form, the input schema's quantization, which is how
a Session receives them. `tick` is part of the frame, so while input arrives a Session records an
entry per player per tick, and none while it holds a frame. A `null` entry records a frame going
away (a player away or leaving).

The Session records into a log given as `SessionOptions.recordLog` (`docs/net.md` A.5):
`recordInputs` on its Simulation, plus the tick of every lifecycle *join*, *spawn* and *leave* it
runs and the ticks its loop drops. `@conduit/game/server` provides `createReplayRun` (`docs/game.md` 2), so a test replays a real
game with `replay({ createRun: (seed, tickRate) => createReplayRun(game, { regionLoader, hooks, seed,
tickRate }) }, log, checkpoints)`, building the loader and hooks afresh for each run.

### 2.12 Determinism rules

Applies to every module in `sim`, `world`, `protocol` and to game systems.

1. Never iterate a `Map`/`Set` whose keys are entities or region ids to produce a side effect; use
   `store.entities()`, `world.query`, or a sorted array. `Map`/`Set` are allowed for lookup only.
2. Never `Object.keys`/`for..in`/`Object.entries` over an object with dynamic keys; schema field
   walks use the field-spec array, whose order is declaration order.
3. No `Date`, `Math.random`, `performance`, `setTimeout`, `setInterval`, `queueMicrotask`,
   `process.hrtime`, `crypto.randomUUID`. All randomness via `ctx.rng` / `ctx.regionRng`.
4. Every `Array.prototype.sort` call passes an explicit comparator (numeric or string compare).
   Typed-array `sort()` is numeric without one, but the lint cannot tell the two apart, so code
   under `simGlobs` passes a comparator there too.
5. No floating-point accumulation across ticks outside a component field (see 2.7).
6. Region activation and deactivation occur only inside `RegionManager.update`, before `step`.
7. No dependence on `EntityId` numeric values beyond ordering (ids are stable across replay because
   allocation is deterministic; they are still not persisted).

Rules 2, 3 and 4 are mechanical and enforced by the eslint purity block
(`docs/consuming.md` §2, `no-restricted-globals` / `no-restricted-properties` / `no-restricted-syntax`):
banned globals and calls for `packages/{math,protocol,sim,world}/src` and for any glob a game lists
under `simGlobs` in `conduitEslint({ simGlobs })`; a zero-argument `.sort()` call is reported. Rules 1, 5, 6 and 7 are review rules covered by
`determinism.test.ts`.

---

## 3. Files

### packages/math

| File | Exports |
| --- | --- |
| `src/index.ts` | re-exports everything below |
| `src/vec2.ts` | `Vec2`, `v2` |
| `src/vec3.ts` | `Vec3`, `v3` |
| `src/quat.ts` | `Quat`, `q` |
| `src/scalar.ts` | `EPS`, `PI`, `TAU`, `HALF_PI`, `clamp`, `lerp`, `wrapAngle`, `lerpAngle` |
| `src/rng.ts` | `Rng` |
| `src/fnv.ts` | `FNV_BASIS`, `FNV_PRIME`, `fnv1a32`, `fnv1a32u32` |
| `src/mat4.ts` | `decomposeMat4(m: ArrayLike<number> /* column-major 16 */, outT: Vec3, outR: Quat, outS: Vec3): void` (used by `@conduit/assets` `deriveModelMeta`, docs/assets.md 5.4) |

| Test | Proves |
| --- | --- |
| `test/vec.test.ts` | `add/sub/scale/dot/cross/length/normalize/lerp/distance` for v2 and v3; `out` aliasing an input is correct; omitted `out` allocates; zero-length normalize returns zero |
| `test/quat.test.ts` | `multiply` associativity and identity; `conjugate` inverts a rotation; `rotateVec3` of +Z by `fromAxisAngle(+Y, PI/2)` gives +X within EPS; `fromEuler` equals the explicit product form for 100 seeded angle triples; `slerp` endpoints, midpoint of 90 degrees, and shortest-arc sign flip; `slerp` with near-identical inputs does not produce NaN |
| `test/scalar.test.ts` | `wrapAngle` maps `PI` to `PI`, `-PI` to `PI`, `3PI` to `PI`, `-3PI` to `PI`, `2PI` to `0`; `lerpAngle(3.0, -3.0, 0.5)` crosses through `PI`; `clamp` bounds |
| `test/rng.test.ts` | seed 1 known-answer vector; same seed twice gives identical 10 000-draw sequences; `int(lo,hi)` stays inclusive over 100 000 draws; `fork('a')` twice differs, and `fork` is reproducible after `restore`; `state/restore` round-trip mid-stream |
| `test/fnv.test.ts` | known answers for `''`, `'a'`, `'foobar'` (`0xbf9cf968`); string and equal UTF-8 bytes hash identically; non-ASCII input encodes as UTF-8; `fnv1a32u32` equals `fnv1a32` over the 4 LE bytes |

### packages/sim

| File | Exports |
| --- | --- |
| `src/index.ts` | re-exports everything below |
| `src/entity.ts` | `EntityId`, `ENTITY_NONE` (both re-exported from `@conduit/protocol`), `SLOT_BITS`, `SLOT_MASK`, `GEN_SHIFT`, `GEN_MASK`, `LOCAL_BIT`, `MAX_SLOTS`, `SERVER_GEN_WRAP`, `LOCAL_GEN_BASE`, `slotOf`, `genOf`, `makeId`, `isLocal`, `LocalIdAllocator` |
| `src/errors.ts` | `StaleEntity`, `MissingComponent`, `AlreadyPresent`, `UnknownComponent`, `DuplicateSystem`, `TickOrder` |
| `src/component.ts` | `ComponentOpts`, `ComponentType`, `defineComponent`, `buildCreate`, `buildCopy` (schema walkers) |
| `src/components.ts` | `Transform`, `Region`, `Model`, `Owner`, `Name`, `CORE_COMPONENTS` |
| `src/store.ts` | `ComponentStore` |
| `src/world.ts` | `World` |
| `src/hash.ts` | `hashWorld(world: World, scratch?: ByteWriter): number` (used by `World.hash`, which passes its reusable writer; default a fresh writer) |
| `src/system.ts` | `Phase`, `PHASES`, `System`, `defineSystem` |
| `src/events.ts` | `EventOpts`, `EventType`, `defineEvent`, `Emitted`, `ReplicatedEvent`, `EventBus`, `MAX_OUTBOX`, `RegionChanged` |
| `src/context.ts` | `SimContext`, `RegionsApi`, `SpatialApi`, `RegionDefLike`, `RegionId` (`= string`, the same alias `@conduit/world` exports), `InputFrame` (type alias re-exported from protocol's `defineInput`) |
| `src/simulation.ts` | `Simulation`, `SimulationOpts`, `MAX_PLAYERS` |
| `src/fixedLoop.ts` | `FixedLoop`, `FixedLoopOpts`, `MAX_CATCH_UP_TICKS` |
| `src/replay.ts` | `InputLog`, `InputLogEntry`, `LifecycleEntry`, `LifecycleEvent`, `SkipEntry`, `Checkpoint`, `ReplayResult`, `ReplayRun`, `ReplayableGame`, `recordInputs`, `record`, `replay` |

| Test | Proves |
| --- | --- |
| `test/entity.test.ts` | `makeId/slotOf/genOf` round-trip at bit boundaries (slot `0xFFFFF`, gen `2047`); `isLocal` on allocator output; local ids are rejected by `World`; generation wraps at `SERVER_GEN_WRAP` without setting bit 31 |
| `test/store.test.ts` | add/read/write/set/remove semantics incl. every stamp (`version` set on add/write/set, cleared on remove; `removedAt` set on remove, untouched by add); swap-remove keeps `sparse` consistent under 10 000 random ops against a reference `Map`; `entities()` ascending by slot after random churn; adds during iteration not visited; `add` on present throws; `set` deep-copies nested vec fields; writes between steps stamp `world.tick + 1` |
| `test/world.test.ts` | create/destroy deferred: destroyed entity alive until `applyDestroys`, then stale id throws on `add/get/write/remove/destroy` and `alive` is false; slot reuse bumps generation; double destroy idempotent; `destroyedThisTick` lists in call order; capacity growth keeps all stores consistent |
| `test/query.test.ts` | query order equals ascending slot order regardless of insertion order; smallest-store selection yields the same set as brute force; entities removed mid-iteration are not yielded; empty query yields all alive |
| `test/events.test.ts` | `consume` sees only same-tick events in emit order; local events vanish at `endTick`; replicated events appear in `drainOutbox` with the correct tick and region; outbox cap drops oldest and counts |
| `test/simulation.test.ts` | phase order then registration order recorded by probe systems; tail runs after postSim and before destroys apply; `step` with wrong tick throws; `inputs(p)` returns placed frames and is not cleared; `onInputsPlaced` gets every player's frame (`undefined` included) of the tick before the phases, while stepping, and a throwing hook propagates like a throwing system; `skip` moves the tick on with no phase, tail or frames, keeps the stamps of writes and events made between steps for the next step, takes only a count >= 1, not while stepping, and closes registration |
| `test/determinism.test.ts` | two `Simulation`s with the same seed and the same 600-tick input log produce identical `world.hash()` every tick; a different seed differs by tick 2; a store mutated through `write` changes the hash and `read` does not |
| `test/hash.test.ts` | hash ignores non-replicated stores; hash follows quantization (a 0.0004 m change under `fixed32(0.001)` does not change the hash, 0.001 does); hash order independent of add order |
| `test/fixedLoop.test.ts` | the 3600 +/- 1 virtual-clock case, the cap-at-5 overrun case, a 300 ms stall whose dropped ticks skip their numbers and leave every tick on its deadline, stop cancels the pending timer, the ~2 s real-timer case; the 10-minute Spike 2a histogram case with `CONDUIT_SLOW=1` (2.10) |
| `test/replay.test.ts` | `record` then `replay` on a toy `ReplayableGame` passes (checkpoints through the first multiple of `every` at or after the last tick; replay runs on to a later checkpoint); corrupting one input entry fails at the first checkpoint after it with the right tick, and another seed at the first checkpoint; lifecycle steps reach `run.lifecycle` before that tick's frames, in log order, and a run without `lifecycle` is a `TypeError`; malformed logs, checkpoints and intervals are `RangeError`s before a run is created, and a log survives JSON; `recordInputs` records only changed encodings (held frames and equal bytes add nothing), `null` once when a frame goes away, quantized copies, sorted entries, chains an earlier hook and uninstalls; a log recorded while a driver plays a toy run replays to the driver's hashes, also with ticks skipped (none stepped, none checkpointed, and without its skips the log fails at the next checkpoint); skips out of shape, order or place and checkpoints at skipped ticks are `RangeError`s, skips one after another or ending the log replay, and a run without `skip` is a `TypeError` |

## Exact checkpoints and version 2 journals

`World.captureCheckpoint()` and `Simulation.captureCheckpoint()` return detached continuation data,
including hidden components, raw numeric values, allocator generations/free-list order, store dense
order/stamps, queued destroys/events, held inputs and RNG. Restore validates detached data before
installing it. These are separate from the wire-quantized `world.hash()` and application persist-only
region saves. Systems and tail implementations come from the matching game revision.

`encodeExactState`/`decodeExactState` use canonical tagged UTF-8 data with sorted keys and exact finite
IEEE-754 number bits. Undefined and signed zero survive; byte arrays (including Node Buffers) become
owned `Uint8Array` data. Functions, accessors, symbol/nonenumerable fields, sparse/extended arrays,
cycles and unsupported objects fail with diagnostics. Encoding/decoding cap bytes, nodes and depth.
`fullStateDigest` uses SHA-256; `firstStateDifference` reports a path and values/types.
`hierarchicalStateDigests` adds bounded optional subtree diagnostics with an explicit truncation flag.
The legacy replication checksum remains unchanged.

`createCommandJournal({compatibility, stateSchemaHash, tickRate, seed, sessionEpoch})` creates a version 2
recording. Its committed ticks contain ordered connection transitions/accepted future input queues,
scheduled external decisions, lifecycle, consumed inputs, declared simulation messages, external
results and observed region activation/save decisions. Failed ticks append a separate failure and
publish no successful tick. Explicit `finalTick` preserves idle tails; skipped intervals never execute.
The default recording bounds are 1,000,000 records, 1,000,000 executed ticks and 64 MiB, with practical
hard ceilings, 4,096 records per tick and a reserved failure diagnostic budget. Live overflow faults
the recording session instead of dropping records. Adjacent skip intervals coalesce. Replay also
bounds missing-tick work, skip arithmetic, seek references, diagnostics and total encoded bytes.

Use `encodeCommandJournal`/`decodeCommandJournal`, preserving undefined/signed zero; plain JSON is
not the exact recording format. `replayCommandJournal` checks content/schema compatibility, uses
recorded results, optionally seeks from a verified exact checkpoint, validates its restored tick,
reports the first divergent completed tick, and disposes resources on success or failure. Optional
`attachJournalDiagnostic(journal, tick, executionState)` adds full state and digest within the same
recording budget. A custom adapter must reject unknown command handlers. Version 1 remains supported
by the existing `replay` reader; `readInputOnlyLog` explicitly labels its limits: no commands, initial
checkpoint, declared revision or final idle tick were recorded.

The reproducible command is:

```sh
node scripts/replay-check.mjs artifacts/improvements/step5/example-journal.exact scripts/fixtures/replay-example.mjs
```

It exits unsuccessfully for divergence, missing adapters/commands, incompatible content or faults.
The sample artifact and Node/Chromium codec+integer-RNG comparison live under
`artifacts/improvements/step5`. That exact cross-runtime contract does not assert universal bit
identity for arbitrary game floating-point math; consumers must declare their exact/tolerant policy.

Exact journaling is a bounded diagnostic recording facility, not passive telemetry that can run
forever. Configure an appropriate finite recording window and finish the run before exhaustion.
Dynamic rotation inside a live Session is not provided: start a new recording run with an explicit
checkpoint reference/adapter when continuity is needed. Exhaustion stops the affected Session under
the strict fault policy, retains the prior committed final tick and emits a bounded failure record.
The failure budget is reserved even when optional detailed diagnostics are attached.

The state schema pin is `SchemaRegistry.stateSchemaHash`, derived from canonical component/event/
input/game-message definitions and continuation flags. It excludes wire version, core control
schemas and wire kind numbers. A wire-only framing upgrade therefore does not invalidate an exact
checkpoint or recording. `registry.hash` remains the separate wire-handshake pin.


SimulationOpts.diagnostics optionally measures system invocation boundaries using an explicitly
injected monotonic clock. Diagnostic observers and clocks are isolated from system outcomes;
throwing/nonfinite timing sources are unavailable and never fault simulation. The disabled path
performs no diagnostic clock reads or record construction. Per-system metrics belong to the
driver wrapper; systems remain deterministic and do not read wall time. See docs/net.md for
bounded history, export redaction and measurement limitations.

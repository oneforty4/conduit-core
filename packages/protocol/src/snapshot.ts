import type { ByteReader, ByteWriter } from './bytes.ts';
import { ENTITY_NONE, MAX_REGION_TABLE, REGION_IDX_NONE } from './constants.ts';
import { DecodeError, EncodeError } from './errors.ts';
import type { EntityId } from './fields.ts';
import { REGION_ID_MAX } from './messages.ts';
import type { ComponentLike, SchemaRegistry } from './registry.ts';
import { decodeFields, encodeFields, fieldMaskBytes } from './schema.ts';

export const SNAPSHOT_FLAG_FULL = 0x01;
/** Update component records carry field masks (docs/protocol.md 9.11.1). */
export const SNAPSHOT_FLAG_MASKED = 0x02;
/** Selected coherent units carry their own authoritative tick; absent units retain their old tick. */
export const SNAPSHOT_FLAG_STATE_TICKS = 0x04;

const SNAPSHOT_FLAGS = SNAPSHOT_FLAG_FULL | SNAPSHOT_FLAG_MASKED | SNAPSHOT_FLAG_STATE_TICKS;

/** 19 bytes on the wire. */
export interface SnapshotHeader {
  serverTick: number;
  serverTimeMs: number;
  /** Tick of the previous snapshot sent to this client; 0 if none or FULL. */
  baselineTick: number;
  /** Envelope seq of the Input message whose frame was last applied; 0 if none. */
  lastInputSeq: number;
  /** Tick of the last applied input frame; 0 if none. */
  lastInputTick: number;
  /** bit0 FULL, bit1 MASKED; other bits must be 0 (masked off on decode). */
  flags: number;
}
/** `value` is typed by `registry.component(id).schema`. */
export interface SnapshotComponent {
  id: number;
  value: unknown;
  /**
   * Field mask (docs/protocol.md 9.11.1), only on update components of a MASKED snapshot: `value`
   * then holds exactly the flagged fields, to be merged into the last known value. Absent or
   * `undefined`: `value` is whole.
   */
  mask?: number | undefined;
}
export interface SnapshotCreate {
  entity: EntityId;
  stateTick?: number;
  /** Index into `SnapshotData.regions`, or `REGION_IDX_NONE`. */
  regionIdx: number;
  components: SnapshotComponent[];
}
export interface SnapshotUpdate {
  entity: EntityId;
  stateTick?: number;
  components: SnapshotComponent[];
  removed: number[];
}
export interface SnapshotData {
  header: SnapshotHeader;
  /** Local region table, first-use order. */
  regions: string[];
  creates: SnapshotCreate[];
  updates: SnapshotUpdate[];
  destroys: EntityId[];
}

function truncateOnThrow(w: ByteWriter, start: number, err: unknown): never {
  if (w.length >= start) w.truncate(start);
  throw err;
}

export function writeSnapshotHeader(w: ByteWriter, h: SnapshotHeader): void {
  const start = w.length;
  try {
    if ((h.flags & ~SNAPSHOT_FLAGS) !== 0) {
      throw new EncodeError(
        'range',
        `snapshot flags ${h.flags} set bits other than FULL and MASKED`,
      );
    }
    w.u32(h.serverTick);
    w.u32(h.serverTimeMs);
    w.u32(h.baselineTick);
    w.u16(h.lastInputSeq);
    w.u32(h.lastInputTick);
    w.u8(h.flags);
  } catch (err) {
    truncateOnThrow(w, start, err);
  }
}

export function readSnapshotHeader(r: ByteReader, out?: SnapshotHeader): SnapshotHeader {
  const serverTick = r.u32();
  const serverTimeMs = r.u32();
  const baselineTick = r.u32();
  const lastInputSeq = r.u16();
  const lastInputTick = r.u32();
  const flags = r.u8() & SNAPSHOT_FLAGS;
  if (out === undefined) {
    return { serverTick, serverTimeMs, baselineTick, lastInputSeq, lastInputTick, flags };
  }
  out.serverTick = serverTick;
  out.serverTimeMs = serverTimeMs;
  out.baselineTick = baselineTick;
  out.lastInputSeq = lastInputSeq;
  out.lastInputTick = lastInputTick;
  out.flags = flags;
  return out;
}

function replicatedForEncode(registry: SchemaRegistry, id: number): ComponentLike {
  const def = registry.component(id);
  if (def === undefined || def.replicate !== true) {
    throw new EncodeError('range', `component id ${id} is not a replicated component`);
  }
  return def;
}

/**
 * `masked`: the records are update components of a MASKED snapshot, so components of at most 16
 * fields carry a mask (docs/protocol.md 9.11.1). Otherwise every record is whole and a `mask` is an
 * error.
 */
function writeComponents(
  w: ByteWriter,
  registry: SchemaRegistry,
  comps: SnapshotComponent[],
  masked: boolean,
): void {
  if (comps.length > 255) throw new EncodeError('count', `${comps.length} components > 255`);
  w.u8(comps.length);
  for (const c of comps) {
    const schema = replicatedForEncode(registry, c.id).schema;
    const maskBytes = masked ? fieldMaskBytes(schema) : 0;
    w.u8(c.id);
    if (maskBytes === 0) {
      if (c.mask !== undefined) {
        const where = masked
          ? 'a component of more than 16 fields'
          : 'a create or an unmasked snapshot';
        throw new EncodeError('range', `component ${c.id}: no field mask allowed on ${where}`);
      }
      schema.type.encode(w, c.value);
      continue;
    }
    const mask = c.mask ?? (1 << schema.fieldNames.length) - 1;
    const maskOffset = maskBytes === 1 ? w.reserveU8() : w.reserveU16();
    encodeFields(w, schema, c.value as Partial<unknown>, mask); // validates the mask first
    if (maskBytes === 1) w.patchU8(maskOffset, mask);
    else w.patchU16(maskOffset, mask);
  }
}

function writeCount16(w: ByteWriter, n: number, what: string): void {
  if (n > 65535) throw new EncodeError('count', `${n} ${what} > 65535`);
  w.u16(n);
}

/**
 * Encodes a Snapshot payload (docs/protocol.md 9.11). Creates, updates and destroys must each be in
 * strictly ascending entity id (each id is written as its gap from the one before,
 * `EncodeError('range')` otherwise); producers order components by ascending id. With
 * `SNAPSHOT_FLAG_MASKED` set, update components carry field masks (9.11.1); without it the bytes
 * are those of the unmasked layout. On a throw the writer is truncated back.
 */
export function encodeSnapshot(w: ByteWriter, registry: SchemaRegistry, s: SnapshotData): void {
  const start = w.length;
  try {
    writeSnapshotHeader(w, s.header);
    const regionCount = s.regions.length;
    if (regionCount > MAX_REGION_TABLE) {
      throw new EncodeError('count', `${regionCount} regions > MAX_REGION_TABLE`);
    }
    w.u8(regionCount);
    for (const id of s.regions) w.utf8(id, REGION_ID_MAX);

    writeCount16(w, s.creates.length, 'creates');
    let previous = ENTITY_NONE;
    for (const c of s.creates) {
      previous = writeEntity(w, c.entity, previous);
      if ((s.header.flags & SNAPSHOT_FLAG_STATE_TICKS) !== 0)
        writeStateTick(w, c.stateTick ?? s.header.serverTick, s.header.serverTick);
      if (c.regionIdx !== REGION_IDX_NONE && !(c.regionIdx >= 0 && c.regionIdx < regionCount)) {
        throw new EncodeError('range', `regionIdx ${c.regionIdx} outside the region table`);
      }
      w.u8(c.regionIdx);
      writeComponents(w, registry, c.components, false);
    }

    const masked = (s.header.flags & SNAPSHOT_FLAG_MASKED) !== 0;
    writeCount16(w, s.updates.length, 'updates');
    previous = ENTITY_NONE;
    for (const u of s.updates) {
      previous = writeEntity(w, u.entity, previous);
      if ((s.header.flags & SNAPSHOT_FLAG_STATE_TICKS) !== 0)
        writeStateTick(w, u.stateTick ?? s.header.serverTick, s.header.serverTick);
      writeComponents(w, registry, u.components, masked);
      if (u.removed.length > 255)
        throw new EncodeError('count', `${u.removed.length} removed > 255`);
      w.u8(u.removed.length);
      for (const id of u.removed) {
        replicatedForEncode(registry, id);
        w.u8(id);
      }
    }

    writeCount16(w, s.destroys.length, 'destroys');
    previous = ENTITY_NONE;
    for (const e of s.destroys) previous = writeEntity(w, e, previous);
  } catch (err) {
    truncateOnThrow(w, start, err);
  }
}

function readReplicatedId(r: ByteReader, registry: SchemaRegistry): number {
  const offset = r.offset;
  const id = r.u8();
  const def = registry.component(id);
  if (def === undefined || def.replicate !== true) {
    throw new DecodeError('unknown', offset, `component id ${id} is not a replicated component`);
  }
  return id;
}

/** `masked`: as for `writeComponents`. */
function readComponents(
  r: ByteReader,
  registry: SchemaRegistry,
  masked: boolean,
): SnapshotComponent[] {
  const count = r.u8();
  const out: SnapshotComponent[] = [];
  for (let i = 0; i < count; i++) {
    const id = readReplicatedId(r, registry);
    const schema = registry.component(id)!.schema;
    const maskBytes = masked ? fieldMaskBytes(schema) : 0;
    if (maskBytes === 0) {
      out.push({ id, value: schema.type.decode(r) });
      continue;
    }
    const maskOffset = r.offset;
    const mask = maskBytes === 1 ? r.u8() : r.u16();
    const fieldCount = schema.fieldNames.length;
    if (mask >= 1 << fieldCount) {
      throw new DecodeError(
        'range',
        maskOffset,
        `component ${id}: field mask ${mask} sets a bit beyond its ${fieldCount} fields`,
      );
    }
    out.push({ id, value: decodeFields(r, schema, mask), mask });
  }
  return out;
}

/**
 * Decodes a Snapshot payload, allocating fresh component values. A record that carried a field mask
 * decodes with `mask` set and only the flagged fields in `value` (docs/protocol.md 9.11.1).
 */
export function decodeSnapshot(r: ByteReader, registry: SchemaRegistry): SnapshotData {
  const header = readSnapshotHeader(r);

  const tableOffset = r.offset;
  const regionCount = r.u8();
  if (regionCount > MAX_REGION_TABLE) {
    throw new DecodeError('count', tableOffset, `${regionCount} regions > MAX_REGION_TABLE`);
  }
  const regions: string[] = [];
  for (let i = 0; i < regionCount; i++) regions.push(r.utf8(REGION_ID_MAX));

  const createCount = r.u16();
  const creates: SnapshotCreate[] = [];
  let previous = ENTITY_NONE;
  for (let i = 0; i < createCount; i++) {
    const entity = readEntity(r, previous);
    previous = entity;
    const stateTick =
      (header.flags & SNAPSHOT_FLAG_STATE_TICKS) !== 0
        ? readStateTick(r, header.serverTick)
        : undefined;
    const idxOffset = r.offset;
    const regionIdx = r.u8();
    if (regionIdx >= regionCount && regionIdx !== REGION_IDX_NONE) {
      throw new DecodeError(
        'range',
        idxOffset,
        `regionIdx ${regionIdx} >= regionCount ${regionCount}`,
      );
    }
    const components = readComponents(r, registry, false);
    creates.push({
      entity,
      regionIdx,
      components,
      ...(stateTick === undefined ? {} : { stateTick }),
    });
  }

  const masked = (header.flags & SNAPSHOT_FLAG_MASKED) !== 0;
  const updateCount = r.u16();
  const updates: SnapshotUpdate[] = [];
  previous = ENTITY_NONE;
  for (let i = 0; i < updateCount; i++) {
    const entity = readEntity(r, previous);
    previous = entity;
    const stateTick =
      (header.flags & SNAPSHOT_FLAG_STATE_TICKS) !== 0
        ? readStateTick(r, header.serverTick)
        : undefined;
    const components = readComponents(r, registry, masked);
    const removedCount = r.u8();
    const removed: number[] = [];
    for (let j = 0; j < removedCount; j++) removed.push(readReplicatedId(r, registry));
    updates.push({
      entity,
      components,
      removed,
      ...(stateTick === undefined ? {} : { stateTick }),
    });
  }

  const destroyCount = r.u16();
  const destroys: EntityId[] = [];
  previous = ENTITY_NONE;
  for (let i = 0; i < destroyCount; i++) {
    previous = readEntity(r, previous);
    destroys.push(previous);
  }

  return { header, regions, creates, updates, destroys };
}

/**
 * A record's entity (docs/protocol.md 9.11): the varuint of its id less the previous record's of
 * the same list (`ENTITY_NONE` before the first) less 1, so ids must strictly ascend. Returns it.
 */
export function writeEntity(w: ByteWriter, entity: EntityId, previous: EntityId): EntityId {
  if (!Number.isInteger(entity) || entity <= previous || entity > 0xffffffff)
    throw new EncodeError('range', `Snapshot: entity ${entity} does not ascend from ${previous}`);
  w.varuint(entity - previous - 1);
  return entity;
}

/** The entity of a record whose list's previous record was `previous` (`writeEntity`). */
export function readEntity(r: ByteReader, previous: EntityId): EntityId {
  const offset = r.offset;
  const entity = previous + 1 + r.varuint();
  if (entity > 0xffffffff) throw new DecodeError('range', offset, 'Snapshot: entity id beyond u32');
  return entity;
}

/** STATE_TICKS (9.11.2): `tick` as the varuint of its age, `serverTick - tick`. */
function writeStateTick(writer: ByteWriter, tick: number, serverTick: number): void {
  if (!Number.isInteger(tick) || tick < 0 || tick > serverTick)
    throw new EncodeError('range', 'Snapshot: invalid authoritative unit tick');
  writer.varuint(serverTick - tick);
}
function readStateTick(reader: ByteReader, serverTick: number): number {
  const offset = reader.offset;
  const age = reader.varuint();
  if (age > serverTick)
    throw new DecodeError('range', offset, 'Snapshot: authoritative unit tick before tick 0');
  return serverTick - age;
}

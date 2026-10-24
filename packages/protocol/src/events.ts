import type { ByteReader, ByteWriter } from './bytes.ts';
import { MAX_REGION_TABLE, REGION_IDX_NONE } from './constants.ts';
import { DecodeError, EncodeError } from './errors.ts';
import { REGION_ID_MAX } from './messages.ts';
import type { EventDef, SchemaRegistry } from './registry.ts';

export interface WireEvent {
  eventId: number;
  tick: number;
  /** Index into `EventsData.regions`, or `REGION_IDX_NONE` for a global event. */
  regionIdx: number;
  /** Typed by `registry.event(eventId).schema`. */
  payload: unknown;
}

export interface EventsData {
  /** Local region table, same rules as Snapshot. */
  regions: string[];
  /** Ascending tick, then emission order. */
  events: WireEvent[];
}

/**
 * Encodes an Events payload (docs/protocol.md 9.12):
 * `u8 regionCount | str(64) x regionCount | u16 eventCount | (u8 eventId | u32 tick | u8 regionIdx |
 * payload) x eventCount`. On a throw the writer is truncated back.
 */
export function encodeEvents(w: ByteWriter, registry: SchemaRegistry, e: EventsData): void {
  const start = w.length;
  try {
    const regionCount = e.regions.length;
    if (regionCount > MAX_REGION_TABLE) {
      throw new EncodeError('count', `${regionCount} regions > MAX_REGION_TABLE`);
    }
    w.u8(regionCount);
    for (const id of e.regions) w.utf8(id, REGION_ID_MAX);
    if (e.events.length > 65535)
      throw new EncodeError('count', `${e.events.length} events > 65535`);
    w.u16(e.events.length);
    for (const ev of e.events) {
      const def = registry.event(ev.eventId);
      if (def === undefined || def.replicate !== true) {
        throw new EncodeError('range', `event id ${ev.eventId} is not a replicated event`);
      }
      if (ev.regionIdx !== REGION_IDX_NONE && !(ev.regionIdx >= 0 && ev.regionIdx < regionCount)) {
        throw new EncodeError('range', `regionIdx ${ev.regionIdx} outside the region table`);
      }
      w.u8(ev.eventId);
      w.u32(ev.tick);
      w.u8(ev.regionIdx);
      def.schema.type.encode(w, ev.payload);
    }
  } catch (err) {
    if (w.length >= start) w.truncate(start);
    throw err;
  }
}

/** Decodes an Events payload, allocating fresh payloads. */
export function decodeEvents(r: ByteReader, registry: SchemaRegistry): EventsData {
  const tableOffset = r.offset;
  const regionCount = r.u8();
  if (regionCount > MAX_REGION_TABLE) {
    throw new DecodeError('count', tableOffset, `${regionCount} regions > MAX_REGION_TABLE`);
  }
  const regions: string[] = [];
  for (let i = 0; i < regionCount; i++) regions.push(r.utf8(REGION_ID_MAX));

  const count = r.u16();
  const events: WireEvent[] = [];
  for (let i = 0; i < count; i++) {
    const idOffset = r.offset;
    const eventId = r.u8();
    const def: EventDef | undefined = registry.event(eventId);
    if (def === undefined || def.replicate !== true) {
      throw new DecodeError('unknown', idOffset, `event id ${eventId} is not a replicated event`);
    }
    const tick = r.u32();
    const idxOffset = r.offset;
    const regionIdx = r.u8();
    if (regionIdx >= regionCount && regionIdx !== REGION_IDX_NONE) {
      throw new DecodeError(
        'range',
        idxOffset,
        `regionIdx ${regionIdx} >= regionCount ${regionCount}`,
      );
    }
    events.push({ eventId, tick, regionIdx, payload: def.schema.type.decode(r) });
  }
  return { regions, events };
}

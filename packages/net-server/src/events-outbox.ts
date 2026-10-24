import { type EventsData, REGION_IDX_NONE, type WireEvent } from '@conduit/protocol';
import type { ReplicatedEvent } from '@conduit/sim';
import type { RegionId } from '@conduit/world';
import type { ClientConn } from './client-conn.ts';
import { PENDING_EVENTS_MAX } from './constants.ts';
import type { SessionStats } from './stats.ts';

/**
 * Whether a client receives `ev` (docs/net.md A.8.3): a global event (no region) reaches every
 * playing client, a regional one only clients whose `wantedRegions ∩ reportedRegions` holds its
 * region.
 */
export function wantsEvent(
  conn: Pick<ClientConn, 'wantedRegions' | 'reportedRegions'>,
  ev: Pick<ReplicatedEvent, 'regionId'>,
): boolean {
  const region = ev.regionId;
  return (
    region === undefined || (conn.wantedRegions.has(region) && conn.reportedRegions.has(region))
  );
}

/**
 * Appends `ev` to the client's queue. Beyond `PENDING_EVENTS_MAX` the oldest queued event is dropped
 * and counted in `stats.eventsDropped`. The queue keeps the order events were drained in: ascending
 * tick, then emission order.
 */
export function queueEvent(
  conn: Pick<ClientConn, 'pendingEvents'>,
  ev: ReplicatedEvent,
  stats?: Pick<SessionStats, 'eventsDropped'>,
): void {
  const queue = conn.pendingEvents;
  queue.push(ev);
  if (queue.length <= PENDING_EVENTS_MAX) return;
  queue.shift();
  if (stats !== undefined) stats.eventsDropped++;
}

/**
 * `events` as one Events payload (docs/protocol.md 9.12), in the given order: `eventId = typeId`,
 * a local region table in first-use order, `REGION_IDX_NONE` for a global event. Payloads are shared,
 * not copied (the bus copied them on `emit`).
 */
export function eventsData(events: readonly ReplicatedEvent[]): EventsData {
  const regions: RegionId[] = [];
  const index = new Map<RegionId, number>();
  const wire: WireEvent[] = [];
  for (const ev of events) {
    let regionIdx: number = REGION_IDX_NONE;
    const region = ev.regionId;
    if (region !== undefined) {
      const known = index.get(region);
      if (known === undefined) {
        regionIdx = regions.push(region) - 1;
        index.set(region, regionIdx);
      } else {
        regionIdx = known;
      }
    }
    wire.push({ eventId: ev.typeId, tick: ev.tick, regionIdx, payload: ev.payload });
  }
  return { regions, events: wire };
}

/** Removes every event queued for the client and returns them as one Events payload (`eventsData`). */
export function takeEvents(conn: Pick<ClientConn, 'pendingEvents'>): EventsData {
  const events = conn.pendingEvents;
  conn.pendingEvents = [];
  return eventsData(events);
}

/**
 * Splits a payload of at least two events into its first and second half, in order, each with its
 * own region table (first-use order). The Session splits a batch that does not fit one message.
 */
export function splitEvents(data: EventsData): [EventsData, EventsData] {
  const n = data.events.length;
  if (n < 2) throw new RangeError(`splitEvents: needs at least 2 events, got ${n}`);
  const mid = n >>> 1;
  return [sliceEvents(data, 0, mid), sliceEvents(data, mid, n)];
}

function sliceEvents(data: EventsData, from: number, to: number): EventsData {
  const regions: string[] = [];
  const index = new Map<string, number>();
  const events: WireEvent[] = [];
  for (let i = from; i < to; i++) {
    const ev = data.events[i] as WireEvent;
    if (ev.regionIdx === REGION_IDX_NONE) {
      events.push(ev);
      continue;
    }
    const region = data.regions[ev.regionIdx];
    if (region === undefined) {
      throw new RangeError(`splitEvents: regionIdx ${ev.regionIdx} outside the region table`);
    }
    let regionIdx = index.get(region);
    if (regionIdx === undefined) {
      regionIdx = regions.push(region) - 1;
      index.set(region, regionIdx);
    }
    events.push(regionIdx === ev.regionIdx ? ev : { ...ev, regionIdx });
  }
  return { regions, events };
}

import {
  type EventDef,
  type EventsData,
  REGION_IDX_NONE,
  type SchemaRegistry,
} from '@conduit/protocol';
import type { RegionId } from '@conduit/world';
import { freezeOwned } from './readonly-view.ts';
import { EVENT_BUFFER_MAX } from './constants.ts';

/**
 * A replicated event as `NetClient` emits it on `'event'`, at render time (docs/net.md B.3, B.7).
 * `RenderWorld.pushEvent` takes exactly this object (docs/render.md 3).
 */
export interface ReplicatedEventInfo {
  /** Stable within this client connection; arrival and presentation hooks share it. */
  readonly id?: string;
  readonly connectionEpoch?: number;
  readonly order?: number;
  def: EventDef;
  /** The server tick the event was emitted in. */
  tick: number;
  /** The region it was emitted in; `null` for a global event. */
  regionId: RegionId | null;
  /** Decoded with `def.schema`; a fresh object per event. */
  payload: unknown;
}

/**
 * Replicated events waiting for the render clock (docs/net.md B.7). Kept in `(tick, arrival)`
 * order; beyond `capacity` the first in that order (the oldest) is dropped. `shiftDue` hands out
 * the events whose tick the render tick has reached.
 */
export class EventBuffer {
  readonly capacity: number;
  private readonly registry: SchemaRegistry;
  private readonly queue: ReplicatedEventInfo[] = [];
  private droppedCount = 0;

  constructor(registry: SchemaRegistry, capacity: number = EVENT_BUFFER_MAX) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`EventBuffer: capacity must be an integer >= 1, got ${capacity}`);
    }
    this.registry = registry;
    this.capacity = capacity;
  }

  /** Events buffered. */
  get length(): number {
    return this.queue.length;
  }

  /** Events dropped by the capacity since construction. */
  get dropped(): number {
    return this.droppedCount;
  }

  /**
   * An `Events` payload on arrival: each event, in payload order, becomes a `ReplicatedEventInfo`
   * (`def = registry.event(eventId)`, `regionId` from the payload's region table). Throws
   * `RangeError`, buffering none of them, for an event id or region index that `decodeEvents` would
   * have rejected.
   */
  push(
    data: EventsData,
    options?: {
      identify(index: number): { id: string; connectionEpoch: number; order: number };
      onArrival(event: ReplicatedEventInfo): void;
    },
  ): void {
    const incoming: ReplicatedEventInfo[] = [];
    for (const ev of data.events) {
      const def = this.registry.event(ev.eventId);
      if (def === undefined || def.replicate !== true) {
        throw new RangeError(`EventBuffer: event id ${ev.eventId} is not a replicated event`);
      }
      const regionId = ev.regionIdx === REGION_IDX_NONE ? null : data.regions[ev.regionIdx];
      if (regionId === undefined) {
        throw new RangeError(`EventBuffer: regionIdx ${ev.regionIdx} outside the region table`);
      }
      incoming.push(
        Object.freeze({
          def,
          tick: ev.tick,
          regionId,
          payload: freezeOwned(def.schema.copy(ev.payload, def.schema.create())),
          ...options?.identify(incoming.length),
        }),
      );
    }
    for (const ev of incoming) this.add(ev);
    for (const ev of incoming) options?.onArrival(ev);
  }

  /** Buffers one event after every buffered event whose tick is not later (arrival order within a tick). */
  add(ev: ReplicatedEventInfo): void {
    const queue = this.queue;
    const last = queue[queue.length - 1];
    if (last === undefined || last.tick <= ev.tick) {
      queue.push(ev);
    } else {
      let lo = 0;
      let hi = queue.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if ((queue[mid] as ReplicatedEventInfo).tick <= ev.tick) lo = mid + 1;
        else hi = mid;
      }
      queue.splice(lo, 0, ev);
    }
    if (queue.length > this.capacity) {
      queue.shift();
      this.droppedCount++;
    }
  }

  /** The next event in `(tick, arrival)` order, without removing it. */
  peek(): ReplicatedEventInfo | undefined {
    return this.queue[0];
  }

  /**
   * Removes and returns the next event when its tick is at or before `renderTick` (fractional);
   * `undefined` otherwise. Call until it returns `undefined` to dispatch every due event in order.
   */
  shiftDue(renderTick: number): ReplicatedEventInfo | undefined {
    const head = this.queue[0];
    if (head === undefined || !(head.tick <= renderTick)) return undefined;
    this.queue.shift();
    return head;
  }

  /** Forgets every buffered event (a new connection or a resync). */
  clear(): void {
    this.queue.length = 0;
  }
}

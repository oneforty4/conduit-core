import {
  ByteReader,
  DecodeError,
  decodeSnapshot,
  snapshotLimits,
  SNAPSHOT_FLAG_FULL,
  type SchemaRegistry,
  type SnapshotData,
  type SnapshotLimits,
  type SnapshotPart,
} from '@conduit/protocol';

interface Assembly {
  id: number;
  tick: number;
  baselineTick: number;
  count: number;
  totalBytes: number;
  reset: boolean;
  next: number;
  offset: number;
  began: number;
  progressed: number;
  bytes: Uint8Array;
}
/** One reliable FIFO transaction. No replica state is exposed before complete validation. */
export class SnapshotAssembly {
  private current: Assembly | null = null;
  private limits: Readonly<SnapshotLimits>;
  constructor(limits: Partial<SnapshotLimits> = {}) {
    this.limits = snapshotLimits(limits);
  }
  configure(limits: SnapshotLimits): void {
    this.reset();
    this.limits = snapshotLimits(limits);
  }
  reset(): void {
    this.current = null;
  }
  get pending(): boolean {
    return this.current !== null;
  }
  get deadline(): number | undefined {
    const current = this.current;
    return current === null
      ? undefined
      : Math.min(
          current.progressed + this.limits.inactivityMs,
          current.began + this.limits.lifetimeMs,
        );
  }
  expire(now: number): boolean {
    const deadline = this.deadline;
    if (deadline !== undefined && now >= deadline) {
      this.reset();
      return true;
    }
    return false;
  }
  accept(part: SnapshotPart, now: number, registry: SchemaRegistry): SnapshotData | null {
    const fail = (message: string): never => {
      this.reset();
      throw new DecodeError('range', 0, `Snapshot assembly: ${message}`);
    };
    if (!Number.isFinite(now)) return fail('invalid monotonic time');
    if (this.expire(now)) return fail('progress/lifetime timeout');
    if (
      ![part.id, part.tick, part.baselineTick, part.totalBytes, part.count, part.index].every(
        (value) => Number.isInteger(value) && value >= 0,
      ) ||
      part.totalBytes < 1 ||
      part.id > 0xffffffff ||
      part.tick > 0xffffffff ||
      part.baselineTick > part.tick ||
      part.totalBytes > this.limits.maxBytes ||
      part.count > this.limits.maxParts ||
      part.count < 1 ||
      part.index >= part.count ||
      part.data.byteLength < 1 ||
      part.totalBytes < part.count
    )
      return fail('unsupported bounds');
    if (
      this.current !== null &&
      this.current.id !== part.id &&
      !(part.index === 0 && part.reset === true && part.baselineTick === 0)
    )
      return fail('overlapping transaction without explicit full reset');
    if (this.current === null || this.current.id !== part.id) {
      if (part.index !== 0) return fail('transaction must begin with part zero');
      this.current = {
        id: part.id,
        tick: part.tick,
        baselineTick: part.baselineTick,
        count: part.count,
        totalBytes: part.totalBytes,
        reset: part.reset === true,
        next: 0,
        offset: 0,
        began: now,
        progressed: now,
        bytes: new Uint8Array(part.totalBytes),
      };
    }
    const current = this.current;
    if (
      part.index !== current.next ||
      (part.reset === true) !== current.reset ||
      part.count !== current.count ||
      part.totalBytes !== current.totalBytes ||
      part.tick !== current.tick ||
      part.baselineTick !== current.baselineTick ||
      part.data.byteLength > current.totalBytes - current.offset ||
      now < current.progressed
    )
      return fail('inconsistent metadata or order');
    current.bytes.set(part.data, current.offset);
    current.offset += part.data.byteLength;
    current.next++;
    current.progressed = now;
    if (current.next < current.count) {
      if (current.offset === current.totalBytes) return fail('bytes exhausted before final part');
      return null;
    }
    if (current.offset !== current.totalBytes) return fail('final byte count mismatch');
    this.reset();
    const reader = new ByteReader(current.bytes);
    const snapshot = decodeSnapshot(reader, registry);
    if (
      reader.remaining() !== 0 ||
      snapshot.header.serverTick !== current.tick ||
      snapshot.header.baselineTick !== current.baselineTick ||
      (current.reset &&
        ((snapshot.header.flags & SNAPSHOT_FLAG_FULL) === 0 || current.baselineTick !== 0))
    )
      return fail('snapshot header/trailing byte mismatch');
    return snapshot;
  }
}

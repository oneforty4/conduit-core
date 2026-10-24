import type { ByteReader, ByteWriter } from './bytes.ts';
import { DecodeError, EncodeError } from './errors.ts';
import { f } from './fields.ts';

export interface SnapshotLimits {
  maxBytes: number;
  maxParts: number;
  inactivityMs: number;
  lifetimeMs: number;
}
export const DEFAULT_SNAPSHOT_LIMITS: Readonly<SnapshotLimits> = Object.freeze({
  maxBytes: 4 * 1024 * 1024,
  maxParts: 256,
  inactivityMs: 5000,
  lifetimeMs: 120_000,
});
export const SnapshotLimitsField = f.struct({
  maxBytes: f.u32,
  maxParts: f.u16,
  inactivityMs: f.u32,
  lifetimeMs: f.u32,
});
export const SNAPSHOT_PART_HEADER_BYTES = 21;
export const SNAPSHOT_PART_MAX_DATA = 65535 - SNAPSHOT_PART_HEADER_BYTES;

export function snapshotLimits(input: Partial<SnapshotLimits> = {}): Readonly<SnapshotLimits> {
  const limits = { ...DEFAULT_SNAPSHOT_LIMITS, ...input };
  if (
    !Number.isInteger(limits.maxBytes) ||
    limits.maxBytes < 64 ||
    limits.maxBytes > 16 * 1024 * 1024 ||
    !Number.isInteger(limits.maxParts) ||
    limits.maxParts < 1 ||
    limits.maxParts > 1024 ||
    !Number.isInteger(limits.inactivityMs) ||
    limits.inactivityMs < 100 ||
    limits.inactivityMs > 60_000 ||
    !Number.isInteger(limits.lifetimeMs) ||
    limits.lifetimeMs < limits.inactivityMs ||
    limits.lifetimeMs > 600_000
  )
    throw new RangeError('Snapshot: unsupported assembly limits');
  return Object.freeze(limits);
}
export interface SnapshotPart {
  id: number;
  tick: number;
  baselineTick: number;
  index: number;
  count: number;
  totalBytes: number;
  data: Uint8Array;
  reset?: boolean;
}
function valid(part: SnapshotPart): boolean {
  return (
    [part.id, part.tick, part.baselineTick, part.index, part.count, part.totalBytes].every(
      (n) => Number.isInteger(n) && n >= 0,
    ) &&
    part.id <= 0xffffffff &&
    part.tick <= 0xffffffff &&
    part.baselineTick <= part.tick &&
    part.count > 0 &&
    part.count <= 1024 &&
    part.index < part.count &&
    part.totalBytes > 0 &&
    part.totalBytes <= 16 * 1024 * 1024 &&
    part.data.byteLength > 0 &&
    part.data.byteLength <= SNAPSHOT_PART_MAX_DATA &&
    part.data.byteLength <= part.totalBytes
  );
}
export function encodeSnapshotPart(writer: ByteWriter, part: SnapshotPart): void {
  if (!valid(part)) throw new EncodeError('range', 'SnapshotPart: invalid transaction metadata');
  writer.u32(part.id);
  writer.u32(part.tick);
  writer.u32(part.baselineTick);
  writer.u16(part.index);
  writer.u16(part.count);
  writer.u32(part.totalBytes);
  writer.u8(part.reset ? 1 : 0);
  writer.bytes(part.data);
}
export function decodeSnapshotPart(reader: ByteReader): SnapshotPart {
  const id = reader.u32(),
    tick = reader.u32(),
    baselineTick = reader.u32(),
    index = reader.u16(),
    count = reader.u16(),
    totalBytes = reader.u32();
  const flags = reader.u8();
  if (flags > 1)
    throw new DecodeError('range', reader.offset - 1, 'SnapshotPart: unsupported flags');
  const part = {
    id,
    tick,
    baselineTick,
    index,
    count,
    totalBytes,
    reset: flags === 1,
    data: reader.bytes(reader.remaining()),
  };
  if (!valid(part)) throw new DecodeError('range', 0, 'SnapshotPart: invalid transaction metadata');
  return part;
}

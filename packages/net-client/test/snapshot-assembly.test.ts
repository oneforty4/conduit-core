import {
  ByteWriter,
  encodeSnapshot,
  REGION_IDX_NONE,
  SNAPSHOT_FLAG_FULL,
  type SnapshotData,
  type SnapshotPart,
} from '@conduit/protocol';
import { describe, expect, it } from 'vitest';
import { SnapshotAssembly } from '../src/snapshot-assembly.ts';
import { ReplicaWorld } from '../src/replica-world.ts';
import { TEST_COMPONENTS, Tag, testRegistry } from './helpers.ts';

const registry = testRegistry();
function snapshot(tick = 1): SnapshotData {
  return {
    header: {
      serverTick: tick,
      serverTimeMs: tick * 16,
      baselineTick: 0,
      lastInputSeq: 0,
      lastInputTick: 0,
      flags: SNAPSHOT_FLAG_FULL,
    },
    regions: [],
    creates: Array.from({ length: 4000 }, (_, index) => ({
      entity: index + 1,
      regionIdx: REGION_IDX_NONE,
      components: [
        { id: registry.componentId(Tag), value: { label: 'abcdefghijklmno', n: index } },
      ],
    })),
    updates: [],
    destroys: [],
  };
}
function parts(data: SnapshotData, count = 4, id = 1, reset = false): SnapshotPart[] {
  const writer = new ByteWriter();
  encodeSnapshot(writer, registry, data);
  const bytes = new Uint8Array(writer.view());
  const chunk = Math.ceil(bytes.length / count);
  return Array.from({ length: count }, (_, index) => ({
    id,
    tick: data.header.serverTick,
    baselineTick: data.header.baselineTick,
    index,
    count,
    totalBytes: bytes.length,
    reset,
    data: bytes.subarray(index * chunk, Math.min(bytes.length, (index + 1) * chunk)),
  }));
}

describe('bounded reliable snapshot assembly', () => {
  it('applies/acknowledges a full population only after all ordered parts validate', () => {
    const assembly = new SnapshotAssembly();
    const replica = new ReplicaWorld(registry, TEST_COMPONENTS, { tickRate: 60, snapshotEvery: 3 });
    const messages = parts(snapshot());
    expect(messages[0]!.totalBytes).toBeGreaterThan(65535);
    for (const part of messages.slice(0, -1)) {
      expect(assembly.accept(part, 0, registry)).toBeNull();
      expect(replica.size).toBe(0);
    }
    const completed = assembly.accept(messages.at(-1)!, 1, registry)!;
    replica.applySnapshot(completed);
    expect(replica.size).toBe(4000);
    expect(assembly.pending).toBe(false);
  });
  it('rejects overlapping IDs and permits only an explicit complete FULL reset', () => {
    const assembly = new SnapshotAssembly();
    const first = parts(snapshot());
    assembly.accept(first[0]!, 0, registry);
    expect(() => assembly.accept(parts(snapshot(2), 4, 2)[0]!, 1, registry)).toThrow('overlapping');
    assembly.accept(first[0]!, 2, registry);
    const replacement = parts(snapshot(2), 4, 2, true);
    for (const part of replacement.slice(0, -1))
      expect(assembly.accept(part, 3, registry)).toBeNull();
    expect(assembly.accept(replacement.at(-1)!, 4, registry)?.header.serverTick).toBe(2);
  });
  it('rejects wrong order, inconsistent headers, bounds and trailing bytes before publication', () => {
    const messages = parts(snapshot());
    const assembly = new SnapshotAssembly();
    assembly.accept(messages[0]!, 0, registry);
    expect(() => assembly.accept(messages[2]!, 1, registry)).toThrow('order');
    assembly.accept(messages[0]!, 2, registry);
    expect(() => assembly.accept({ ...messages[1]!, baselineTick: 1 }, 3, registry)).toThrow(
      'inconsistent',
    );
    expect(() => new SnapshotAssembly({ maxBytes: 64 }).accept(messages[0]!, 0, registry)).toThrow(
      'bounds',
    );
    expect(() => assembly.accept({ ...messages[0]!, totalBytes: -1 }, 0, registry)).toThrow(
      'bounds',
    );
  });
  it('uses both inactivity and absolute lifetime, then releases the retained buffer', () => {
    const assembly = new SnapshotAssembly({ inactivityMs: 5000, lifetimeMs: 12000 });
    const messages = parts(snapshot());
    assembly.accept(messages[0]!, 0, registry);
    assembly.accept(messages[1]!, 4000, registry);
    assembly.accept(messages[2]!, 8000, registry);
    expect(() => assembly.accept(messages[3]!, 12000, registry)).toThrow('timeout');
    expect(assembly.pending).toBe(false);
    assembly.accept(messages[0]!, 20000, registry);
    expect(assembly.expire(25000)).toBe(true);
    expect(assembly.pending).toBe(false);
  });
});

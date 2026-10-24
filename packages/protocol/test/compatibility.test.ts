import { describe, expect, it } from 'vitest';
import {
  ByteReader,
  ByteWriter,
  canonicalGameplayData,
  CompatibilityField,
  compatibilityDifferences,
  copyCompatibilityDescriptor,
  createCompatibilityDescriptor,
  decodeWith,
  encodeWith,
  FrameWriter,
  hashGameplayData,
  HelloSchema,
  CoreKind,
  WIRE_VERSION,
  readFrame,
} from '../src/index.ts';

const declaration = {
  simulationRevision: 'sim-7',
  gameplayDigests: { inventory: 'abc', collisions: 'def' },
};

describe('compatibility declarations', () => {
  it('pins immutable independent data and reports named differences', () => {
    const descriptor = createCompatibilityDescriptor('fixture', declaration);
    const copy = copyCompatibilityDescriptor(descriptor);
    expect(copy).toEqual(descriptor);
    expect(copy).not.toBe(descriptor);
    expect(Object.isFrozen(copy.gameplayDigests[0])).toBe(true);
    expect(descriptor.gameplayDigests.map((entry) => entry.name)).toEqual([
      'collisions',
      'inventory',
    ]);
    const changed = createCompatibilityDescriptor('fixture', {
      ...declaration,
      gameplayDigests: { ...declaration.gameplayDigests, collisions: 'changed' },
    });
    expect(compatibilityDifferences(descriptor, changed)).toEqual(['gameplayDigests.collisions']);
    expect(
      compatibilityDifferences(descriptor, createCompatibilityDescriptor('fixture')),
    ).toContain('mode');
  });
  it('rejects overbounds, ambiguous ordering and invalid schema-only declarations', () => {
    expect(() => createCompatibilityDescriptor('x'.repeat(65))).toThrow();
    expect(() =>
      createCompatibilityDescriptor('fixture', { simulationRevision: '', gameplayDigests: {} }),
    ).toThrow();
    const good = createCompatibilityDescriptor('fixture', declaration);
    expect(() =>
      copyCompatibilityDescriptor({
        ...good,
        gameplayDigests: [...good.gameplayDigests].reverse(),
      }),
    ).toThrow();
    expect(() => copyCompatibilityDescriptor({ ...good, mode: 'schema-only' })).toThrow();
    expect(() => copyCompatibilityDescriptor({ ...good, descriptorVersion: 2 })).toThrow();
  });
  it('roundtrips bounded Hello metadata below gateway and frame limits and rejects old wire', () => {
    const digests = Object.fromEntries(
      Array.from({ length: 16 }, (_, i) => [`${i}`.padStart(64, 'x'), 'a'.repeat(128)]),
    );
    const compatibility = createCompatibilityDescriptor('g'.repeat(64), {
      simulationRevision: 'r'.repeat(128),
      gameplayDigests: digests,
    });
    const hello = {
      compatibility,
      protocolVersion: 1,
      registryHash: 1,
      sessionToken: 't'.repeat(2048),
      reconnectToken: 'r'.repeat(64),
      displayName: 'd'.repeat(32),
    };
    const writer = new ByteWriter();
    encodeWith(writer, HelloSchema, hello);
    expect(decodeWith(new ByteReader(writer.view()), HelloSchema)).toEqual(hello);
    expect(writer.length).toBeLessThan(65536 - 11);
    const frame = new FrameWriter();
    frame.begin();
    frame.message(CoreKind.Hello, 0, 0, (w) => encodeWith(w, HelloSchema, hello));
    const encoded = frame.finish();
    expect(encoded[0]).toBe(4);
    expect(WIRE_VERSION).toBe(4);
    for (const oldVersion of [1, 2, 3]) {
      encoded[0] = oldVersion;
      expect(() => readFrame(encoded, () => {})).toThrow('wire version');
    }
    expect(Object.isFrozen(CompatibilityField)).toBe(true);
  });
});

describe('build-time canonical gameplay digests', () => {
  it('ignores object insertion order and retains ordered arrays and signed zero', async () => {
    expect(await hashGameplayData({ b: 2, a: [1, 2] })).toBe(
      await hashGameplayData({ a: [1, 2], b: 2 }),
    );
    expect(await hashGameplayData([1, 2])).not.toBe(await hashGameplayData([2, 1]));
    expect(canonicalGameplayData(-0)).toBe('-0');
    expect(await hashGameplayData(-0)).not.toBe(await hashGameplayData(0));
    expect(await hashGameplayData(null)).toBe(
      '74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b',
    );
  });
  it('rejects nonfinite, undefined, sparse/cyclic/nonplain data and accessors', () => {
    const cycle: unknown[] = [];
    cycle.push(cycle);
    const array = [1];
    Object.assign(array, { extra: true });
    for (const value of [
      NaN,
      Infinity,
      undefined,
      [undefined],
      Array(1),
      cycle,
      new Date(),
      array,
      {
        get random() {
          return 1;
        },
      },
    ])
      expect(() => canonicalGameplayData(value)).toThrow();
  });
});

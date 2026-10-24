import { Rng } from '@conduit/math';
import { SchemaRegistry, defineInput, f } from '@conduit/protocol';
import {
  CORE_COMPONENTS,
  Model,
  Name,
  Owner,
  Region,
  RegionChanged,
  Transform,
  World,
  defineComponent,
  type ComponentType,
  type EntityId,
} from '@conduit/sim';
import { describe, expect, it } from 'vitest';
import {
  BLOB_NAMESPACE,
  BLOB_VERSION,
  BlobError,
  GridWorld,
  decodeBlob,
  deserializeEntities,
  emptyBlob,
  encodeBlob,
  serializeEntity,
  type RegionBlob,
  type SerializedEntity,
} from '../src/index.ts';

// docs/world.md §10 `test/blob.test.ts`.

/** A persisted component with every nested kind a blob must carry through JSON. */
const Cargo = defineComponent(
  'Cargo',
  {
    items: f.array(f.struct({ sku: f.str(16), count: f.u16 }), 8),
    note: f.optional(f.str(32)),
    heading: f.angle16(),
    owner: f.entity(),
    sealed: f.bool,
  },
  { persist: true },
);
const Marker = defineComponent('Marker', { label: f.str(16) }, { persist: false });

const registry = new SchemaRegistry({
  components: [...CORE_COMPONENTS, Cargo, Marker],
  messages: [],
  events: [RegionChanged],
  input: defineInput({ tick: f.u32 }),
});

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const bytesOf = (s: string): Uint8Array => new TextEncoder().encode(s);

function crate(world: World): EntityId {
  const e = world.create();
  world.add(e, Region, { id: 'cell/1_1' });
  world.add(e, Owner, { player: 3 });
  world.add(e, Marker, { label: 'debug' });
  world.add(e, Transform, {
    pos: { x: 12.5, y: -3, z: 1e6 + 0.123 },
    rot: { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 },
    vel: { x: 1, y: 0, z: -2.5 },
  });
  world.add(e, Name, { value: 'crate' });
  world.add(e, Model, { asset: 'crate', variant: 2 });
  world.add(e, Cargo, {
    items: [
      { sku: 'ore', count: 12 },
      { sku: 'gas', count: 1 },
    ],
    note: 'fragile',
    heading: 1.25,
    owner: 77,
    sealed: true,
  });
  return e;
}

describe('serializeEntity', () => {
  it('includes only persist: true components, in component-id order, as copies', () => {
    const world = new World(registry);
    const e = crate(world);
    const s = serializeEntity(world, e) as SerializedEntity;
    const persisted = world
      .stores()
      .filter((store) => store.type.persist && store.has(e))
      .map((store) => store.type.name);
    expect(persisted).toEqual(['Cargo', 'Model', 'Name', 'Transform']); // ids follow sorted names
    expect(s.components.map(([name]) => name)).toEqual(persisted);
    for (const [name, value] of s.components) {
      const store = world.stores().find((st) => st.type.name === name);
      expect(value, name).toEqual(store?.read(e));
      expect(value, name).not.toBe(store?.read(e));
    }
    // Deep copies: editing the serialized value leaves the entity alone.
    const cargo = s.components[0]?.[1] as { items: { count: number }[] };
    (cargo.items[0] as { count: number }).count = 999;
    expect(world.get(e, Cargo).items[0]?.count).toBe(12);
  });

  it('serializes entities with no persisted component, or not alive, to null', () => {
    const world = new World(registry);
    const bare = world.create();
    world.add(bare, Region, { id: 'cell/0_0' });
    world.add(bare, Owner, { player: 1 });
    world.add(bare, Marker, { label: 'x' });
    expect(serializeEntity(world, bare)).toBeNull();
    expect(serializeEntity(world, world.create())).toBeNull();
    const gone = crate(world);
    world.destroy(gone);
    world.applyDestroys();
    expect(serializeEntity(world, gone)).toBeNull();
  });
});

describe('encodeBlob / decodeBlob', () => {
  it('round-trips a blob as UTF-8 JSON; null decodes to null', () => {
    const world = new World(registry);
    const entities = [crate(world), crate(world)].map((e) => serializeEntity(world, e));
    const blob: RegionBlob = {
      version: 1,
      savedTick: 4321,
      entities: entities as SerializedEntity[],
      rngState: 0xdeadbeef,
      gameData: { weather: 'rain', spawns: [1, 2, 3], nested: { ok: true, label: 'é✓' } },
    };
    const bytes = encodeBlob(blob);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(text(bytes)).toBe(JSON.stringify(blob));
    expect(decodeBlob(bytes)).toEqual(blob);
    expect(decodeBlob(null)).toBeNull();

    const { gameData: _omitted, ...plain } = blob;
    expect(text(encodeBlob({ ...plain, gameData: undefined }))).not.toContain('gameData');
    expect(decodeBlob(encodeBlob(plain))).toEqual(plain);
    const arrivals: RegionBlob = { ...plain, inboxOnly: true };
    expect(decodeBlob(encodeBlob(arrivals))).toEqual(arrivals);
  });

  it('bad version throws BlobError, and so does every shape mismatch', () => {
    const good = JSON.parse(text(encodeBlob(emptyBlob(regionDef())))) as Record<string, unknown>;
    const bad = (patch: Record<string, unknown>): Uint8Array =>
      bytesOf(JSON.stringify({ ...good, ...patch }));
    expect(() => decodeBlob(bad({ version: 2 }))).toThrow(BlobError);
    expect(() => decodeBlob(bad({ version: 2 }))).toThrow(/version 2/);
    expect(() => decodeBlob(bad({ version: '1' }))).toThrow(BlobError);
    const cases: [string, Uint8Array][] = [
      ['no version', bytesOf(JSON.stringify({ ...good, version: undefined }))],
      ['not JSON', bytesOf('{"version":1,')],
      ['not UTF-8', new Uint8Array([0x7b, 0xff, 0x7d])],
      ['an array', bytesOf('[1]')],
      ['null', bytesOf('null')],
      ['negative savedTick', bad({ savedTick: -1 })],
      ['fractional savedTick', bad({ savedTick: 1.5 })],
      ['rngState above u32', bad({ rngState: 2 ** 32 })],
      ['string rngState', bad({ rngState: '7' })],
      ['entities not an array', bad({ entities: {} })],
      ['entity without components', bad({ entities: [{}] })],
      ['component not a pair', bad({ entities: [{ components: [['Name']] }] })],
      ['component name not a string', bad({ entities: [{ components: [[1, {}]] }] })],
      ['inboxOnly false', bad({ inboxOnly: false })],
    ];
    for (const [what, bytes] of cases) expect(() => decodeBlob(bytes), what).toThrow(BlobError);
  });

  it('encodeBlob throws BlobError for game data JSON cannot hold', () => {
    const blob: RegionBlob = { ...emptyBlob(regionDef()), gameData: { big: 10n } };
    expect(() => encodeBlob(blob)).toThrow(BlobError);
  });

  it('rngState restore continues the stream exactly', () => {
    const rng = new Rng(0xc0ffee);
    for (let i = 0; i < 37; i++) rng.next();
    rng.fork('loot'); // forks advance the parent too
    const blob: RegionBlob = { ...emptyBlob(regionDef()), rngState: rng.state() };
    const restored = new Rng(0);
    restored.restore((decodeBlob(encodeBlob(blob)) as RegionBlob).rngState);
    for (let i = 0; i < 10_000; i++) expect(restored.next()).toBe(rng.next());
  });

  it('emptyBlob holds nothing but the region seed', () => {
    const def = regionDef();
    expect(emptyBlob(def)).toEqual({ version: 1, savedTick: 0, entities: [], rngState: def.seed });
    expect(emptyBlob({ ...def, seed: -1 }).rngState).toBe(0xffffffff);
    expect(BLOB_NAMESPACE).toBe('region');
    expect(BLOB_VERSION).toBe(1);
  });
});

describe('deserializeEntities', () => {
  it('re-creates entities in order with their persisted components and the given Region', () => {
    const source = new World(registry);
    const originals = [crate(source), crate(source)];
    source.write(originals[1] as EntityId, Name).value = 'second';
    const blob = decodeBlob(
      encodeBlob({
        version: 1,
        savedTick: 9,
        entities: originals.map((e) => serializeEntity(source, e) as SerializedEntity),
        rngState: 1,
      }),
    ) as RegionBlob;

    const target = new World(registry);
    target.create(); // ids differ from the source world's
    const ids = deserializeEntities(target, registry, blob.entities, 'cell/2_2');
    expect(ids).toHaveLength(2);
    expect(ids[0] as EntityId).toBeLessThan(ids[1] as EntityId); // creation order
    ids.forEach((e, i) => {
      const from = originals[i] as EntityId;
      expect(target.get(e, Region).id).toBe('cell/2_2');
      for (const type of [Transform, Model, Name, Cargo] as ComponentType<unknown>[]) {
        expect(target.get(e, type), type.name).toEqual(source.get(from, type));
      }
      expect(target.has(e, Owner)).toBe(false);
      expect(target.has(e, Marker)).toBe(false);
    });
    expect(target.get(ids[1] as EntityId, Name).value).toBe('second');
    // Stored values are copied in, never referenced.
    (blob.entities[0]?.components[2]?.[1] as { value: string }).value = 'edited';
    expect(target.get(ids[0] as EntityId, Name).value).toBe('crate');
  });

  it('creates nothing for entities it cannot restore', () => {
    const world = new World(registry);
    const valid: SerializedEntity = { components: [['Name', { value: 'ok' }]] };
    const cases: [string, SerializedEntity][] = [
      ['unknown component', { components: [['Hovercraft', {}]] }],
      [
        'listed twice',
        {
          components: [
            ['Name', { value: 'a' }],
            ['Name', { value: 'b' }],
          ],
        },
      ],
      ['Region', { components: [['Region', { id: 'cell/0_0' }]] }],
      ['value not an object', { components: [['Name', 'crate']] }],
      ['null value', { components: [['Name', null]] }],
    ];
    for (const [what, broken] of cases) {
      expect(() => deserializeEntities(world, registry, [valid, broken], 'cell/0_0'), what).toThrow(
        BlobError,
      );
      expect(world.count(), what).toBe(0);
    }
    expect(deserializeEntities(world, registry, [], 'cell/0_0')).toEqual([]);
  });
});

function regionDef() {
  const def = new GridWorld({ cellSize: 256, cols: 4, rows: 4, worldSeed: 5 }).get('cell/2_3');
  if (def === undefined) throw new Error('no region');
  return def;
}

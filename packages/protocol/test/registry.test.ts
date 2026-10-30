import { Rng } from '@conduit/math';
import { describe, expect, it } from 'vitest';
import {
  CORE_MESSAGES,
  CoreKind,
  defineEvent,
  defineInput,
  defineMessage,
  defineSchema,
  f,
  fnv1a32,
  GAME_MESSAGE_KIND_BASE,
  MAX_COMPONENTS,
  MAX_EVENTS,
  MAX_GAME_MESSAGES,
  SchemaRegistry,
  type ComponentLike,
  type EventDef,
  type FieldMap,
  type InputFrameBase,
  type MessageDef,
  type RegistryInput,
  type Schema,
} from '../src/index.ts';

function comp(
  name: string,
  fields: FieldMap,
  replicate = true,
  interpolate: string[] = [],
  extrapolateWith?: string,
): ComponentLike {
  const c = { name, schema: defineSchema(fields), replicate, interpolate };
  return extrapolateWith === undefined ? c : { ...c, extrapolateWith };
}

const input = defineInput({ tick: f.u32, move: f.vec2(f.fixed16(0.01)), fire: f.bool });

function baseInput(): RegistryInput {
  return {
    components: [
      comp('Transform', { pos: f.vec3(f.fixed32(0.001)), rot: f.quat() }, true, ['pos', 'rot']),
      comp('Health', { hp: f.u16 }),
      comp('AiBrain', { state: f.u8 }, false),
      comp('Name', { value: f.str(32) }),
      comp('zLast', { v: f.u8 }),
      comp('Cargo', { items: f.array(f.u16, 16) }),
    ],
    messages: [
      defineMessage('chat', 'both', { text: f.str(140) }),
      defineMessage('Trade', 'c2s', { item: f.u16, qty: f.u8 }),
      defineMessage('Notice', 's2c', { text: f.str(64) }),
      defineMessage('Build', 'c2s', { kind: f.u8 }),
      defineMessage('ZoneInfo', 's2c', { id: f.str(64) }),
    ],
    events: [
      defineEvent('Explosion', { power: f.u8 }, { replicate: true }),
      defineEvent('Sound', { id: f.u16 }, { replicate: true }),
      defineEvent('AiThought', { n: f.u8 }),
      defineEvent('Chime', {}, { replicate: true }),
    ],
    input,
  };
}

function shuffled<T>(items: readonly T[], rng: Rng): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    const t = out[i] as T;
    out[i] = out[j] as T;
    out[j] = t;
  }
  return out;
}

function snapshotIds(r: SchemaRegistry, src: RegistryInput): unknown {
  return {
    components: r.components.map((c) => c.name),
    componentIds: src.components.map((c) => [c.name, r.componentId(c)]),
    kinds: src.messages.map((m) => [m.name, r.messageKind(m)]),
    events: src.events.map((e) => [e.name, r.eventId(e)]),
    hash: r.hash,
    descriptor: r.descriptor(),
  };
}

describe('id assignment', () => {
  it('is identical under random permutations of components, messages and events', () => {
    const src = baseInput();
    const reference = snapshotIds(new SchemaRegistry(src), src);
    const rng = new Rng(99);
    for (let i = 0; i < 50; i++) {
      const permuted: RegistryInput = {
        components: shuffled(src.components, rng),
        messages: shuffled(src.messages, rng),
        events: shuffled(src.events, rng),
        input: src.input,
      };
      expect(snapshotIds(new SchemaRegistry(permuted), src)).toEqual(reference);
    }
  });

  it('sorts names by UTF-16 code unit, not locale', () => {
    const names = ['beta', 'Alpha', 'alpha', 'Zeta', 'B_1', 'B1'];
    const r = new SchemaRegistry({
      components: names.map((n) => comp(n, { v: f.u8 })),
      messages: [],
      events: names.map((n) => defineEvent(n, {})),
      input,
    });
    const expected = ['Alpha', 'B1', 'B_1', 'Zeta', 'alpha', 'beta'];
    expect(r.components.map((c) => c.name)).toEqual(expected);
    expect(r.events.map((e) => e.name)).toEqual(expected);
    expect(expected.map((n) => r.componentId(n))).toEqual([0, 1, 2, 3, 4, 5]);
    expect(expected.map((n) => r.eventId(n))).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('gives every component an id and lists replicated ones in id order', () => {
    const src = baseInput();
    const r = new SchemaRegistry(src);
    // AiBrain, Cargo, Health, Name, Transform, zLast
    expect(r.components.map((c) => c.name)).toEqual([
      'AiBrain',
      'Cargo',
      'Health',
      'Name',
      'Transform',
      'zLast',
    ]);
    expect(r.replicated.map((c) => c.name)).toEqual([
      'Cargo',
      'Health',
      'Name',
      'Transform',
      'zLast',
    ]);
    expect(r.componentId('AiBrain')).toBe(0);
    const transform = src.components[0] as ComponentLike;
    expect(r.componentId(transform)).toBe(4);
    expect(r.component(4)).toEqual(transform);
    expect(r.component(6)).toBeUndefined();
    expect(r.component(-1)).toBeUndefined();
    expect(() => r.componentId('Missing')).toThrow(RangeError);
    expect(r.eventId('AiThought')).toBe(0);
    expect(r.event(3)?.name).toBe('Sound');
    expect(r.event(4)).toBeUndefined();
    expect(() => r.eventId('Missing')).toThrow(RangeError);
  });

  it('keeps core kinds fixed and starts game kinds at 128', () => {
    const r = new SchemaRegistry(baseInput());
    for (const def of CORE_MESSAGES) {
      const kind = CoreKind[def.name as keyof typeof CoreKind];
      expect(r.messageKind(def)).toBe(kind);
      expect(r.messageKind(def.name)).toBe(kind);
      expect(r.message(kind)?.name).toBe(def.name);
      expect(r.message(kind)?.core).toBe(true);
    }
    expect(GAME_MESSAGE_KIND_BASE).toBe(128);
    // Build, Notice, Trade, ZoneInfo, chat
    expect(r.messageKind('Build')).toBe(128);
    expect(r.messageKind('Notice')).toBe(129);
    expect(r.messageKind('Trade')).toBe(130);
    expect(r.messageKind('ZoneInfo')).toBe(131);
    expect(r.messageKind('chat')).toBe(132);
    expect(r.message(132)?.core).toBe(false);
    expect(r.message(8)).toBeUndefined();
    expect(r.message(127)).toBeUndefined();
    expect(r.message(133)).toBeUndefined();
    expect(r.messages).toHaveLength(133);
    expect(() => r.messageKind('Nope')).toThrow(RangeError);
  });

  it('uses the registry input schema for the core Input message', () => {
    const r = new SchemaRegistry(baseInput());
    expect(r.input).toBe(input);
    const def = r.message(CoreKind.Input);
    expect(def?.name).toBe('Input');
    expect(def?.direction).toBe('c2s');
    expect(def?.schema.descriptor).toBe(
      'struct{firstTick:u32,frames:array(struct{tick:u32,move:vec2(fixed16(0.01)),fire:bool},4)}',
    );
    expect(r.messageKind(CORE_MESSAGES[2] as MessageDef)).toBe(CoreKind.Input);
  });

  it('assigns kinds per registry, so definitions are reusable', () => {
    const shared = defineMessage('Mid', 'both', {});
    const a = new SchemaRegistry({ components: [], messages: [shared], events: [], input });
    const b = new SchemaRegistry({
      components: [],
      messages: [defineMessage('Aaa', 'c2s', {}), shared],
      events: [],
      input,
    });
    expect(a.messageKind(shared)).toBe(128);
    expect(b.messageKind(shared)).toBe(129);
  });
});

describe('limits and validation', () => {
  it('accepts exactly MAX_COMPONENTS components and rejects one more', () => {
    const make = (n: number): ComponentLike[] =>
      Array.from({ length: n }, (_, i) => comp(`C${String(i).padStart(3, '0')}`, { v: f.u8 }));
    const ok = new SchemaRegistry({
      components: make(MAX_COMPONENTS),
      messages: [],
      events: [],
      input,
    });
    expect(ok.componentId('C255')).toBe(255);
    expect(
      () =>
        new SchemaRegistry({
          components: make(MAX_COMPONENTS + 1),
          messages: [],
          events: [],
          input,
        }),
    ).toThrow(RangeError);
  });

  it('accepts exactly MAX_GAME_MESSAGES game messages and rejects one more', () => {
    const make = (n: number): MessageDef[] =>
      Array.from({ length: n }, (_, i) =>
        defineMessage(`M${String(i).padStart(3, '0')}`, 'both', {}),
      );
    const ok = new SchemaRegistry({
      components: [],
      messages: make(MAX_GAME_MESSAGES),
      events: [],
      input,
    });
    expect(ok.messageKind('M127')).toBe(255);
    expect(ok.messages).toHaveLength(256);
    expect(
      () =>
        new SchemaRegistry({
          components: [],
          messages: make(MAX_GAME_MESSAGES + 1),
          events: [],
          input,
        }),
    ).toThrow(RangeError);
  });

  it('accepts exactly MAX_EVENTS events and rejects one more', () => {
    const make = (n: number): EventDef[] =>
      Array.from({ length: n }, (_, i) => defineEvent(`E${String(i).padStart(3, '0')}`, {}));
    const ok = new SchemaRegistry({
      components: [],
      messages: [],
      events: make(MAX_EVENTS),
      input,
    });
    expect(ok.eventId('E255')).toBe(255);
    expect(
      () =>
        new SchemaRegistry({ components: [], messages: [], events: make(MAX_EVENTS + 1), input }),
    ).toThrow(RangeError);
  });

  it('rejects a game message named like a core message', () => {
    const hello: MessageDef = {
      name: 'Hello',
      direction: 'c2s',
      schema: defineSchema({}),
      core: false,
    };
    expect(
      () => new SchemaRegistry({ components: [], messages: [hello], events: [], input }),
    ).toThrow(RangeError);
    const snapshot: MessageDef = {
      name: 'Snapshot',
      direction: 's2c',
      schema: defineSchema({}),
      core: false,
    };
    expect(
      () => new SchemaRegistry({ components: [], messages: [snapshot], events: [], input }),
    ).toThrow(RangeError);
    // case-sensitive
    const lower = defineMessage('hello', 'c2s', {});
    expect(
      new SchemaRegistry({ components: [], messages: [lower], events: [], input }).messageKind(
        'hello',
      ),
    ).toBe(128);
  });

  it('rejects duplicate and invalid names', () => {
    const empty = { components: [], messages: [], events: [], input };
    expect(
      () => new SchemaRegistry({ ...empty, components: [comp('A', {}), comp('A', { v: f.u8 })] }),
    ).toThrow(RangeError);
    expect(
      () =>
        new SchemaRegistry({
          ...empty,
          messages: [defineMessage('m', 'c2s', {}), defineMessage('m', 's2c', {})],
        }),
    ).toThrow(RangeError);
    expect(
      () => new SchemaRegistry({ ...empty, events: [defineEvent('e', {}), defineEvent('e', {})] }),
    ).toThrow(RangeError);
    expect(() => new SchemaRegistry({ ...empty, components: [comp('bad name', {})] })).toThrow(
      RangeError,
    );
  });

  it('rejects an input schema that does not begin with tick: u32', () => {
    const empty = { components: [], messages: [], events: [] };
    const noTick = defineSchema({ fire: f.bool }) as unknown as Schema<InputFrameBase>;
    const tickSecond = defineSchema({
      fire: f.bool,
      tick: f.u32,
    }) as unknown as Schema<InputFrameBase>;
    const tickU16 = defineSchema({ tick: f.u16 });
    for (const bad of [noTick, tickSecond, tickU16]) {
      expect(() => new SchemaRegistry({ ...empty, input: bad })).toThrow(RangeError);
    }
  });
});

describe('registry hash', () => {
  const hashOf = (src: RegistryInput): number => new SchemaRegistry(src).hash;

  it('is fnv1a32 of the descriptor', () => {
    const r = new SchemaRegistry(baseInput());
    expect(r.hash).toBe(fnv1a32(r.descriptor()));
    expect(Number.isInteger(r.hash) && r.hash >= 0 && r.hash < 2 ** 32).toBe(true);
  });

  it('matches the grammar of docs/protocol.md 7.2 exactly', () => {
    const r = new SchemaRegistry({
      components: [comp('Secret', { s: f.str(4) }, false), comp('Health', { hp: f.u8 })],
      messages: [defineMessage('chat', 'both', { text: f.str(140) })],
      events: [defineEvent('Boom', { power: f.u8 }, { replicate: true })],
      input: defineInput({ tick: f.u32, fire: f.bool }),
    });
    const expected =
      'wire=5' +
      ';components[Health=struct{hp:u8}:r;Secret=struct{s:str(4)}:n]' +
      ';messages[' +
      [
        '1:Hello=struct{maxSessionCapacity:optional(u8),snapshotLimits:optional(struct{maxBytes:u32,maxParts:u16,inactivityMs:u32,lifetimeMs:u32}),compatibility:optional(struct{descriptorVersion:u8,mode:str(11),gameId:str(64),simulationRevision:str(128),gameplayDigests:array(struct{name:str(64),digest:str(128)},16)}),protocolVersion:u16,registryHash:u32,sessionToken:str(2048),reconnectToken:str(64),displayName:str(32)}:c2s',
        '2:Ready=struct{}:c2s',
        '3:Input=struct{firstTick:u32,frames:array(struct{tick:u32,fire:bool},4)}:c2s',
        '4:Ack=struct{lastSnapshotTick:u32}:c2s',
        '5:Ping=struct{clientTimeMs:u32}:c2s',
        '6:RegionLoadState=struct{loaded:array(str(64),255),loading:array(str(64),255)}:c2s',
        '7:Leave=struct{}:c2s',
        '32:Welcome=struct{sessionCapacity:optional(u8),snapshotLimits:optional(struct{maxBytes:u32,maxParts:u16,inactivityMs:u32,lifetimeMs:u32}),compatibility:optional(struct{descriptorVersion:u8,mode:str(11),gameId:str(64),simulationRevision:str(128),gameplayDigests:array(struct{name:str(64),digest:str(128)},16)}),playerId:u8,reconnectToken:str(64),simTickRate:u8,snapshotEvery:u8,serverTick:u32,serverTimeMs:u32,worldSeed:u32}:s2c',
        '33:SessionState=struct{players:array(struct{playerId:u8,name:str(32),state:u8,entity:entity},16)}:s2c',
        '34:Spawned=struct{playerId:u8,entity:entity,regionId:str(64)}:s2c',
        '35:Snapshot=struct{}:s2c',
        '36:Events=struct{}:s2c',
        '37:Pong=struct{clientTimeMs:u32,serverTimeMs:u32,serverTick:u32}:s2c',
        '38:RegionSet=struct{active:array(str(64),255),prefetch:array(str(64),255)}:s2c',
        '39:Rejected=struct{reason:u8,detail:str(256)}:s2c',
        '40:Kicked=struct{reason:u8}:s2c',
        '41:SnapshotPart=struct{}:s2c',
        '128:chat=struct{text:str(140)}:both',
      ].join(';') +
      ']' +
      ';events[Boom=struct{power:u8}:r]' +
      ';input=struct{tick:u32,fire:bool}';
    expect(r.descriptor()).toBe(expected);
  });

  it('writes empty lists as name[]', () => {
    const r = new SchemaRegistry({
      components: [],
      messages: [],
      events: [],
      input: defineInput({ tick: f.u32 }),
    });
    expect(r.descriptor()).toMatch(
      /^wire=5;components\[\];messages\[1:Hello=.*:s2c\];events\[\];input=struct\{tick:u32\}$/,
    );
  });

  it('changes when a component flips replicate, a message changes direction, or the input changes', () => {
    const base = hashOf(baseInput());

    const flipped = baseInput();
    flipped.components = flipped.components.map((c) =>
      c.name === 'Health' ? { ...c, replicate: false } : c,
    );
    expect(hashOf(flipped)).not.toBe(base);

    const direction = baseInput();
    direction.messages = direction.messages.map((m) =>
      m.name === 'Trade' ? defineMessage('Trade', 'both', { item: f.u16, qty: f.u8 }) : m,
    );
    expect(hashOf(direction)).not.toBe(base);

    const input2 = baseInput();
    input2.input = defineInput({
      tick: f.u32,
      move: f.vec2(f.fixed16(0.01)),
      fire: f.bool,
      jump: f.bool,
    });
    expect(hashOf(input2)).not.toBe(base);

    const input3 = baseInput();
    input3.input = defineInput({ tick: f.u32, move: f.vec2(f.fixed16(0.02)), fire: f.bool });
    expect(hashOf(input3)).not.toBe(base);

    const field = baseInput();
    field.components = field.components.map((c) =>
      c.name === 'Health' ? comp('Health', { hp: f.u32 }) : c,
    );
    expect(hashOf(field)).not.toBe(base);

    const event = baseInput();
    event.events = event.events.map((e) =>
      e.name === 'AiThought' ? defineEvent('AiThought', { n: f.u8 }, { replicate: true }) : e,
    );
    expect(hashOf(event)).not.toBe(base);

    const renamed = baseInput();
    renamed.components = renamed.components.map((c) =>
      c.name === 'zLast' ? comp('Last', { v: f.u8 }) : c,
    );
    expect(hashOf(renamed)).not.toBe(base);

    const added = baseInput();
    added.components = [...added.components, comp('Extra', {})];
    expect(hashOf(added)).not.toBe(base);
  });

  it('does not change when interpolate or extrapolateWith change', () => {
    const base = hashOf(baseInput());
    const changed = baseInput();
    changed.components = changed.components.map((c) =>
      c.name === 'Transform'
        ? comp('Transform', { pos: f.vec3(f.fixed32(0.001)), rot: f.quat() }, true, [], 'pos')
        : c,
    );
    expect(hashOf(changed)).toBe(base);
  });
});

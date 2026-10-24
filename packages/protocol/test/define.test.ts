import { describe, expect, it } from 'vitest';
import {
  assertName,
  CORE_MESSAGES,
  defineEvent,
  defineInput,
  defineMessage,
  f,
  NAME_PATTERN,
  SchemaRegistry,
  type FieldMap,
  type FieldType,
  type MessageDirection,
} from '../src/index.ts';

const VALID = ['A', 'a', 'a_1', 'Z9', 'chat', 'Hello_World', 'x'.repeat(64)];
const INVALID = ['', '1a', '_a', 'a-b', 'a b', 'a.b', 'x'.repeat(65), 'caf\u{E9}', ' a'];

describe('assertName', () => {
  it('accepts names matching NAME_PATTERN', () => {
    expect(String(NAME_PATTERN)).toBe('/^[A-Za-z][A-Za-z0-9_]{0,63}$/');
    for (const name of VALID) expect(() => assertName(name)).not.toThrow();
  });

  it('throws RangeError naming the offending name', () => {
    for (const name of INVALID) {
      expect(() => assertName(name)).toThrow(RangeError);
      expect(() => assertName(name)).toThrow(JSON.stringify(name));
    }
  });
});

describe('defineMessage', () => {
  it('builds an immutable game message definition', () => {
    const chat = defineMessage('chat', 'both', { text: f.str(140) });
    expect(chat.name).toBe('chat');
    expect(chat.direction).toBe('both');
    expect(chat.core).toBe(false);
    expect(chat.schema.descriptor).toBe('struct{text:str(140)}');
    expect(Object.isFrozen(chat)).toBe(true);
    expect(defineMessage('Ping2', 'c2s', {}).schema.descriptor).toBe('struct{}');
  });

  it('validates the name', () => {
    for (const name of INVALID) expect(() => defineMessage(name, 'c2s', {})).toThrow(RangeError);
  });

  it('rejects every core message name, case-sensitively', () => {
    for (const core of CORE_MESSAGES) {
      expect(() => defineMessage(core.name, 's2c', {})).toThrow(RangeError);
      expect(() => defineMessage(core.name, 's2c', {})).toThrow(core.name);
    }
    expect(() => defineMessage('hello', 'c2s', {})).not.toThrow();
    expect(() => defineMessage('SNAPSHOT', 's2c', {})).not.toThrow();
  });

  it('validates the direction', () => {
    for (const d of ['c2s', 's2c', 'both'] as const)
      expect(defineMessage('m', d, {}).direction).toBe(d);
    expect(() => defineMessage('m', 'up' as MessageDirection, {})).toThrow(RangeError);
    expect(() => defineMessage('m', '' as MessageDirection, {})).toThrow(RangeError);
  });

  it('validates fields like f.struct and names the message', () => {
    expect(() => defineMessage('Trade', 'c2s', { 'bad-field': f.u8 })).toThrow(RangeError);
    expect(() => defineMessage('Trade', 'c2s', { 'bad-field': f.u8 })).toThrow('Trade');
    expect(() =>
      defineMessage('Trade', 'c2s', { item: f.str as unknown as FieldType<string> }),
    ).toThrow(RangeError);
  });
});

describe('defineEvent', () => {
  it('defaults replicate to false', () => {
    const ev = defineEvent('Boom', { power: f.u8 });
    expect(ev.replicate).toBe(false);
    expect(defineEvent('Boom', { power: f.u8 }, {}).replicate).toBe(false);
    expect(defineEvent('Boom', { power: f.u8 }, { replicate: false }).replicate).toBe(false);
    expect(defineEvent('Boom', { power: f.u8 }, { replicate: true }).replicate).toBe(true);
    expect(ev.name).toBe('Boom');
    expect(ev.schema.descriptor).toBe('struct{power:u8}');
    expect(Object.isFrozen(ev)).toBe(true);
  });

  it('validates the name and fields', () => {
    for (const name of INVALID) expect(() => defineEvent(name, {})).toThrow(RangeError);
    expect(() => defineEvent('Boom', { '9lives': f.u8 })).toThrow(RangeError);
    // core message names are fine for events
    expect(defineEvent('Hello', {}).name).toBe('Hello');
  });
});

describe('defineInput', () => {
  it('accepts tick: f.u32 as the first field, followed by anything', () => {
    expect(defineInput({ tick: f.u32 }).fieldNames).toEqual(['tick']);
    const input = defineInput({
      tick: f.u32,
      move: f.vec2(f.fixed16(0.01)),
      fire: f.bool,
      name: f.str(8),
    });
    expect(input.fieldNames).toEqual(['tick', 'move', 'fire', 'name']);
    expect(input.descriptor).toBe(
      'struct{tick:u32,move:vec2(fixed16(0.01)),fire:bool,name:str(8)}',
    );
  });

  it('throws without a leading u32 tick', () => {
    const cases: FieldMap[] = [
      {},
      { fire: f.bool },
      { fire: f.bool, tick: f.u32 }, // tick not first
      { tick: f.u16 },
      { tick: f.i32 },
      { tick: f.varuint },
      { tick: f.fixed32(1) },
      { Tick: f.u32 },
    ];
    for (const fields of cases) {
      expect(() => defineInput(fields as FieldMap & { tick: FieldType<number> })).toThrow(
        RangeError,
      );
    }
  });

  it('validates the remaining fields', () => {
    expect(() => defineInput({ tick: f.u32, 'x-y': f.u8 })).toThrow(RangeError);
  });
});

describe('reuse across registries', () => {
  it('the same definitions get different kinds and ids in different registries', () => {
    const shared = defineMessage('Mm', 'both', { v: f.u8 });
    const sharedEvent = defineEvent('Ee', { v: f.u8 }, { replicate: true });
    const input = defineInput({ tick: f.u32 });
    const first = new SchemaRegistry({
      components: [],
      messages: [shared],
      events: [sharedEvent],
      input,
    });
    const second = new SchemaRegistry({
      components: [],
      messages: [shared, defineMessage('Aa', 'c2s', {}), defineMessage('Bb', 's2c', {})],
      events: [sharedEvent, defineEvent('Aa', {})],
      input,
    });
    expect(first.messageKind(shared)).toBe(128);
    expect(second.messageKind(shared)).toBe(130);
    expect(first.eventId(sharedEvent)).toBe(0);
    expect(second.eventId(sharedEvent)).toBe(1);
    expect(first.message(128)).toBe(shared);
    expect(second.message(130)).toBe(shared);
    expect(first.hash).not.toBe(second.hash);
  });
});

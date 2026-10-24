import { describe, expect, it } from 'vitest';
import {
  defineEvent,
  defineInput,
  defineMessage,
  defineSchema,
  f,
  SchemaRegistry,
  type ComponentLike,
} from '../src/index.ts';

const input = defineInput({ tick: f.u32 });
const component = (overrides: Partial<ComponentLike> = {}): ComponentLike => ({
  name: 'Shared',
  schema: defineSchema({ x: f.f32 }),
  replicate: true,
  persist: true,
  interpolate: ['x'],
  ...overrides,
});

describe('registry structural identity', () => {
  it('accepts equivalent module copies and rejects each semantic metadata mismatch', () => {
    const registry = new SchemaRegistry({
      components: [component()],
      events: [defineEvent('Event', { x: f.u8 }, { replicate: true })],
      messages: [defineMessage('Message', 'both', { x: f.u8 })],
      input,
    });
    expect(registry.componentId(component())).toBe(0);
    for (const difference of [
      { schema: defineSchema({ x: f.u8 }) },
      { persist: false },
      { replicate: false },
      { interpolate: [] },
      { extrapolateWith: 'x' },
    ])
      expect(() => registry.componentId(component(difference))).toThrow('conflicting component');
    expect(registry.eventId(defineEvent('Event', { x: f.u8 }, { replicate: true }))).toBe(0);
    expect(() => registry.eventId(defineEvent('Event', { x: f.u16 }, { replicate: true }))).toThrow(
      'conflicting event',
    );
    expect(() => registry.eventId(defineEvent('Event', { x: f.u8 }, { replicate: false }))).toThrow(
      'conflicting event',
    );
    expect(registry.messageKind(defineMessage('Message', 'both', { x: f.u8 }))).toBe(128);
    expect(() => registry.messageKind(defineMessage('Message', 'c2s', { x: f.u8 }))).toThrow(
      'conflicting message',
    );
  });

  it('copies frozen shells with mutable nested interpolation and never caches them as immutable', () => {
    const interpolate = ['x'];
    const original = Object.freeze(component({ interpolate }));
    const registry = new SchemaRegistry({
      components: [original],
      events: [],
      messages: [],
      input,
    });
    const descriptor = registry.descriptor();
    expect(registry.componentId(original)).toBe(0);
    interpolate.push('invalid');
    expect(registry.components[0]?.interpolate).toEqual(['x']);
    expect(registry.descriptor()).toBe(descriptor);
    expect(() => registry.componentId(original)).toThrow('conflicting component');
    expect(Object.isFrozen(interpolate)).toBe(false);
  });

  it('rejects mutable custom schema metadata without freezing caller-owned objects', () => {
    const schema = { ...defineSchema({ x: f.f32 }) };
    expect(
      () =>
        new SchemaRegistry({
          components: [component({ schema })],
          events: [],
          messages: [],
          input,
        }),
    ).toThrow('schema metadata must be immutable');
    expect(Object.isFrozen(schema)).toBe(false);
    const fields = { x: { ...f.f32 } };
    const shell = Object.freeze({ ...schema, fields: Object.freeze(fields) });
    expect(
      () =>
        new SchemaRegistry({
          components: [component({ schema: shell })],
          events: [],
          messages: [],
          input,
        }),
    ).toThrow('schema metadata must be immutable');
    expect(Object.isFrozen(fields.x)).toBe(false);
  });
});

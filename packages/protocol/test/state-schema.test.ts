import { describe, expect, it } from 'vitest';
import {
  defineEvent,
  defineInput,
  defineMessage,
  defineSchema,
  f,
  fnv1a32,
  SchemaRegistry,
} from '../src/index.ts';
const component = {
  name: 'State',
  schema: defineSchema({ value: f.f32 }),
  replicate: true,
  persist: true,
  interpolate: [] as string[],
};
const input = defineInput({ tick: f.u32, value: f.f32 });
function registry(components = [component]) {
  return new SchemaRegistry({
    components,
    input,
    messages: [defineMessage('Command', 'c2s', { value: f.u8 })],
    events: [defineEvent('Signal', { value: f.u8 })],
  });
}
describe('simulation state schema identity', () => {
  it('excludes wire version, core control schemas and numeric message kinds', () => {
    const state = registry();
    expect(state.stateDescriptor()).toContain('state-schema=1;components[');
    expect(state.stateDescriptor()).toContain('gameMessages[Command=');
    for (const control of ['wire=', 'Hello=', 'Welcome=', 'Fragment=', 'SessionState='])
      expect(state.stateDescriptor()).not.toContain(control);
    expect(state.stateSchemaHash).toBe(fnv1a32(state.stateDescriptor()));
    expect(state.stateSchemaHash).not.toBe(state.hash);
  });
  it('pins hidden state, input and game schema changes without visual metadata', () => {
    expect(registry([{ ...component, interpolate: ['value'] }]).stateSchemaHash).toBe(
      registry().stateSchemaHash,
    );
    expect(
      registry([{ ...component, schema: defineSchema({ value: f.u16 }) }]).stateSchemaHash,
    ).not.toBe(registry().stateSchemaHash);
    expect(registry([{ ...component, persist: false }]).stateSchemaHash).not.toBe(
      registry().stateSchemaHash,
    );
  });
});

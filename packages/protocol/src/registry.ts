import {
  GAME_MESSAGE_KIND_BASE,
  MAX_COMPONENTS,
  MAX_EVENTS,
  MAX_GAME_MESSAGES,
  NAME_PATTERN,
  WIRE_VERSION,
} from './constants.ts';
import { fnv1a32 } from './hash.ts';
import { CORE_MESSAGES, CoreKind, inputMessageSchema } from './messages.ts';
import type { Schema } from './schema.ts';

export interface ComponentLike<T = unknown> {
  readonly name: string;
  readonly schema: Schema<T>;
  readonly replicate: boolean;
  readonly persist?: boolean;
  /** Field names, subset of `schema.fieldNames`. Not part of the registry hash. */
  readonly interpolate: readonly string[];
  /** Field name. Not part of the registry hash. */
  readonly extrapolateWith?: string;
}

export type MessageDirection = 'c2s' | 's2c' | 'both';

export interface MessageDef<T = unknown> {
  readonly name: string;
  readonly direction: MessageDirection;
  readonly schema: Schema<T>;
  readonly core: boolean;
}

export interface EventDef<T = unknown> {
  readonly name: string;
  readonly schema: Schema<T>;
  readonly replicate: boolean;
}

export interface RegistryInput {
  components: readonly ComponentLike[];
  /** Game messages only; core messages are implicit. */
  messages: readonly MessageDef[];
  events: readonly EventDef[];
  /** From `defineInput`: the first field is `tick: f.u32`. */
  input: Schema<InputFrameBase>;
}

export interface InputFrameBase {
  tick: number;
}

interface Named {
  readonly name: string;
}

function byName(a: Named, b: Named): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** Sorts by name (code-unit order) and rejects bad or duplicate names and overflow. */
function sortedByName<T extends Named>(what: string, items: readonly T[], max: number): T[] {
  const sorted = [...items].sort(byName);
  if (sorted.length > max) {
    throw new RangeError(`SchemaRegistry: ${sorted.length} ${what} exceeds the limit of ${max}`);
  }
  for (let i = 0; i < sorted.length; i++) {
    const name = sorted[i]!.name;
    if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
      throw new RangeError(`SchemaRegistry: invalid ${what} name ${JSON.stringify(name)}`);
    }
    if (i > 0 && sorted[i - 1]!.name === name) {
      throw new RangeError(`SchemaRegistry: duplicate ${what} name ${JSON.stringify(name)}`);
    }
  }
  return sorted;
}

function indexByName(items: readonly (Named | undefined)[]): Map<string, number> {
  const map = new Map<string, number>();
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item !== undefined) map.set(item.name, i);
  }
  return map;
}

function replicateFlag(replicate: boolean): string {
  return replicate ? 'r' : 'n';
}

function componentSignature(c: ComponentLike): string {
  return JSON.stringify([
    c.schema.descriptor,
    c.replicate,
    c.persist ?? false,
    c.interpolate,
    c.extrapolateWith ?? null,
  ]);
}

function eventSignature(e: EventDef): string {
  return JSON.stringify([e.schema.descriptor, e.replicate]);
}

function immutableSchema(schema: Schema<unknown>): boolean {
  return (
    Object.isFrozen(schema) &&
    Object.isFrozen(schema.fields) &&
    Object.isFrozen(schema.fieldNames) &&
    Object.isFrozen(schema.type) &&
    Object.values(schema.fields).every((field) => Object.isFrozen(field))
  );
}

function requireImmutableSchema(schema: Schema<unknown>): void {
  if (!immutableSchema(schema))
    throw new TypeError('SchemaRegistry: schema metadata must be immutable (use defineSchema)');
}

function cacheableComponent(c: ComponentLike): boolean {
  return Object.isFrozen(c) && Object.isFrozen(c.interpolate) && immutableSchema(c.schema);
}

/** Keep factory-built immutable definitions by identity; isolate mutable caller metadata. */
function ownComponent(c: ComponentLike): ComponentLike {
  requireImmutableSchema(c.schema);
  if (cacheableComponent(c)) return c;
  return Object.freeze({ ...c, interpolate: Object.freeze([...c.interpolate]) });
}

function ownDefinition<T extends MessageDef | EventDef>(definition: T): T {
  requireImmutableSchema(definition.schema);
  return Object.isFrozen(definition) ? definition : Object.freeze(Object.assign({}, definition));
}

/**
 * Assigns component ids, message kinds and event ids from sorted names and computes the registry
 * hash checked at handshake (docs/protocol.md 7).
 */
export class SchemaRegistry {
  /** u32, `fnv1a32(descriptor())`. */
  readonly hash: number;
  /** Simulation/save schema identity, independent of wire version and core control layout. */
  readonly stateSchemaHash: number;
  readonly input: Schema<InputFrameBase>;
  /** Index = component id. */
  readonly components: readonly ComponentLike[];
  /** `replicate === true`, ascending id. */
  readonly replicated: readonly ComponentLike[];
  /** Core + game, index = kind (holes are undefined). */
  readonly messages: readonly MessageDef[];
  /** Index = event id. */
  readonly events: readonly EventDef[];

  private readonly componentIds: Map<string, number>;
  private readonly messageKinds: Map<string, number>;
  private readonly eventIds: Map<string, number>;
  private readonly text: string;
  private readonly stateText: string;
  private readonly resolvedComponents = new WeakMap<ComponentLike, number>();
  private readonly resolvedEvents = new WeakMap<EventDef, number>();
  private readonly resolvedMessages = new WeakMap<MessageDef, number>();
  private readonly componentSignatures: readonly string[];
  private readonly eventSignatures: readonly string[];

  constructor(input: RegistryInput) {
    const inputSchema = input.input;
    requireImmutableSchema(inputSchema);
    if (inputSchema.fieldNames[0] !== 'tick' || inputSchema.fields['tick']?.kind !== 'u32') {
      throw new RangeError('SchemaRegistry: the input schema must begin with tick: f.u32');
    }
    this.input = inputSchema;

    const components = sortedByName('components', input.components, MAX_COMPONENTS).map(
      ownComponent,
    );
    this.components = Object.freeze(components);
    this.replicated = Object.freeze(components.filter((c) => c.replicate === true));
    this.componentIds = indexByName(components);
    this.componentSignatures = components.map(componentSignature);
    for (const original of input.components)
      if (cacheableComponent(original))
        this.resolvedComponents.set(original, this.componentIds.get(original.name)!);

    const gameMessages = sortedByName('game messages', input.messages, MAX_GAME_MESSAGES).map(
      ownDefinition,
    );
    const messages: MessageDef[] = [];
    for (const def of CORE_MESSAGES) {
      const kind = CoreKind[def.name as keyof typeof CoreKind];
      // The exported Input definition is a template; this registry substitutes its frame schema.
      this.resolvedMessages.set(def, kind);
      messages[kind] =
        kind === CoreKind.Input
          ? Object.freeze({ ...def, schema: inputMessageSchema(inputSchema) })
          : def;
    }
    for (let i = 0; i < gameMessages.length; i++) {
      const def = gameMessages[i]!;
      if (Object.hasOwn(CoreKind, def.name)) {
        throw new RangeError(
          `SchemaRegistry: game message ${def.name} collides with a core message`,
        );
      }
      if (def.direction !== 'c2s' && def.direction !== 's2c' && def.direction !== 'both') {
        throw new RangeError(`SchemaRegistry: message ${def.name} has an invalid direction`);
      }
      messages[GAME_MESSAGE_KIND_BASE + i] = def;
    }
    this.messages = Object.freeze(messages);
    this.messageKinds = indexByName(messages);
    for (const original of input.messages)
      if (Object.isFrozen(original) && immutableSchema(original.schema))
        this.resolvedMessages.set(original, this.messageKinds.get(original.name)!);

    const events = sortedByName('events', input.events, MAX_EVENTS).map(ownDefinition);
    this.events = Object.freeze(events);
    this.eventIds = indexByName(events);
    this.eventSignatures = events.map(eventSignature);
    for (const original of input.events)
      if (Object.isFrozen(original) && immutableSchema(original.schema))
        this.resolvedEvents.set(original, this.eventIds.get(original.name)!);

    const centries = components.map(
      (c) => `${c.name}=${c.schema.descriptor}:${replicateFlag(c.replicate)}`,
    );
    const mentries: string[] = [];
    for (let kind = 0; kind < messages.length; kind++) {
      const m = messages[kind];
      if (m !== undefined) mentries.push(`${kind}:${m.name}=${m.schema.descriptor}:${m.direction}`);
    }
    const eentries = events.map(
      (e) => `${e.name}=${e.schema.descriptor}:${replicateFlag(e.replicate)}`,
    );
    this.text =
      `wire=${WIRE_VERSION}` +
      `;components[${centries.join(';')}]` +
      `;messages[${mentries.join(';')}]` +
      `;events[${eentries.join(';')}]` +
      `;input=${inputSchema.descriptor}`;
    this.hash = fnv1a32(this.text);
    this.stateText =
      'state-schema=1' +
      `;components[${components.map((component) => `${component.name}=${component.schema.descriptor}:${replicateFlag(component.replicate)}:${component.persist === true ? 'p' : 'n'}`).join(';')}]` +
      `;gameMessages[${gameMessages.map((message) => `${message.name}=${message.schema.descriptor}:${message.direction}`).join(';')}]` +
      `;events[${eentries.join(';')}]` +
      `;input=${inputSchema.descriptor}`;
    this.stateSchemaHash = fnv1a32(this.stateText);
  }

  /** Name lookup, or cached structural resolution including schema and component metadata. */
  componentId(c: ComponentLike | string): number {
    if (typeof c !== 'string') {
      const cached = this.resolvedComponents.get(c);
      if (cached !== undefined) return cached;
    }
    const name = typeof c === 'string' ? c : c.name;
    const id = this.componentIds.get(name);
    if (id === undefined) throw new RangeError(`SchemaRegistry: unknown component ${name}`);
    if (typeof c !== 'string') {
      if (componentSignature(c) !== this.componentSignatures[id])
        throw new RangeError(`SchemaRegistry: conflicting component definition ${name}`);
      if (cacheableComponent(c)) this.resolvedComponents.set(c, id);
    }
    return id;
  }

  component(id: number): ComponentLike | undefined {
    return this.components[id];
  }

  /** Name lookup, or cached structural resolution including schema and direction. */
  messageKind(m: MessageDef | string): number {
    if (typeof m !== 'string') {
      const cached = this.resolvedMessages.get(m);
      if (cached !== undefined) return cached;
    }
    const name = typeof m === 'string' ? m : m.name;
    const kind = this.messageKinds.get(name);
    if (kind === undefined) throw new RangeError(`SchemaRegistry: unknown message ${name}`);
    if (typeof m !== 'string') {
      const canonical = this.messages[kind]!;
      if (
        m.schema.descriptor !== canonical.schema.descriptor ||
        m.direction !== canonical.direction ||
        m.core !== canonical.core
      )
        throw new RangeError(`SchemaRegistry: conflicting message definition ${name}`);
      if (Object.isFrozen(m) && immutableSchema(m.schema)) this.resolvedMessages.set(m, kind);
    }
    return kind;
  }

  message(kind: number): MessageDef | undefined {
    return this.messages[kind];
  }

  /** Name lookup, or cached structural resolution including schema and replication metadata. */
  eventId(e: EventDef | string): number {
    if (typeof e !== 'string') {
      const cached = this.resolvedEvents.get(e);
      if (cached !== undefined) return cached;
    }
    const name = typeof e === 'string' ? e : e.name;
    const id = this.eventIds.get(name);
    if (id === undefined) throw new RangeError(`SchemaRegistry: unknown event ${name}`);
    if (typeof e !== 'string') {
      if (eventSignature(e) !== this.eventSignatures[id])
        throw new RangeError(`SchemaRegistry: conflicting event definition ${name}`);
      if (Object.isFrozen(e) && immutableSchema(e.schema)) this.resolvedEvents.set(e, id);
    }
    return id;
  }

  event(id: number): EventDef | undefined {
    return this.events[id];
  }

  /** Canonical simulation/save schema text; excludes wire headers, kind numbers and core controls. */
  stateDescriptor(): string {
    return this.stateText;
  }

  /** The canonical registry text hashed into `hash` (docs/protocol.md 7.2). */
  descriptor(): string {
    return this.text;
  }
}

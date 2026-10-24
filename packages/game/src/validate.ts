import type { FieldKind, FieldType, MessageDef } from '@conduit/protocol';
import {
  CORE_COMPONENTS,
  type ComponentType,
  type EventType,
  type InputFrame,
  RegionChanged,
} from '@conduit/sim';
import type { GameDefInput } from './types.ts';

export type GameDefErrorCode =
  | 'badId'
  | 'badProtocolVersion'
  | 'badTickRate'
  | 'badSnapshotEvery'
  | 'badSeed'
  | 'duplicateComponent'
  | 'duplicateEvent'
  | 'duplicateMessage'
  | 'duplicateSystem'
  | 'tooManyComponents'
  | 'inputLacksTick'
  | 'badInterpolate'
  | 'badExtrapolate';

/** Thrown by `defineGame`; `message` is `` `${code}: ${detail}` `` (docs/game.md 1). */
export class GameDefError extends Error {
  override readonly name = 'GameDefError';
  readonly code: GameDefErrorCode;

  constructor(code: GameDefErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.code = code;
  }
}

export const GAME_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
export const DEFAULT_TICK_RATE = 60;
export const MIN_TICK_RATE = 10;
export const MAX_TICK_RATE = 240;
export const DEFAULT_SNAPSHOT_EVERY = 3;
/** `Welcome.snapshotEvery` is a u8. */
export const MAX_SNAPSHOT_EVERY = 255;
/** A Snapshot record counts its components in a u8 (docs/protocol.md 9.11). */
export const MAX_GAME_COMPONENTS = 255;

/** Field kinds an `interpolate` entry may name (docs/sim.md 2.4). */
const INTERPOLABLE_KINDS: ReadonlySet<FieldKind> = new Set<FieldKind>([
  'vec2',
  'vec3',
  'quat',
  'angle16',
  'f32',
  'fixed16',
  'fixed32',
]);

/** The checked and merged lists `defineGame` builds the registry from (not yet sorted). */
export interface ValidatedGameDef {
  tickRate: number;
  snapshotEvery: number;
  /** `CORE_COMPONENTS` then the game's, deduplicated by identity. */
  components: ComponentType<unknown>[];
  /** `RegionChanged` then the game's, deduplicated by identity. */
  events: EventType<unknown>[];
  messages: MessageDef<unknown>[];
}

function isIntegerIn(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

function dedupeByIdentity<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

function checkUniqueNames(
  items: readonly { readonly name: string }[],
  code: GameDefErrorCode,
): void {
  const seen = new Set<string>(); // lookup only
  for (const item of items) {
    if (seen.has(item.name)) {
      throw new GameDefError(code, `${JSON.stringify(item.name)} defined twice`);
    }
    seen.add(item.name);
  }
}

function isVec(t: FieldType<unknown> | undefined): t is FieldType<unknown> {
  return t !== undefined && (t.kind === 'vec2' || t.kind === 'vec3');
}

function checkInterpolation(c: ComponentType<unknown>): void {
  const fields = c.schema.fields;
  const names = c.interpolate;
  let firstVec: FieldType<unknown> | undefined;
  for (const name of names) {
    const type = Object.hasOwn(fields, name) ? fields[name] : undefined;
    if (type === undefined || !INTERPOLABLE_KINDS.has(type.kind)) {
      throw new GameDefError(
        'badInterpolate',
        `${c.name}.${name} is not a field of kind ${[...INTERPOLABLE_KINDS].join(' | ')}`,
      );
    }
    if (firstVec === undefined && isVec(type)) firstVec = type;
  }
  const velName = c.extrapolateWith;
  if (velName === undefined) return;
  const vel = Object.hasOwn(fields, velName) ? fields[velName] : undefined;
  if (!isVec(vel) || firstVec === undefined || firstVec.kind !== vel.kind) {
    throw new GameDefError(
      'badExtrapolate',
      `${c.name}.extrapolateWith ${JSON.stringify(velName)} must name a vec2/vec3 field of the same arity as the first vec field in interpolate`,
    );
  }
}

/**
 * Checks a game definition in the order of docs/game.md 1 (scalars, duplicate names, component
 * count, input, interpolation) and returns the merged lists. Throws `GameDefError`.
 */
export function validateGameDef<I extends InputFrame>(def: GameDefInput<I>): ValidatedGameDef {
  if (typeof def.id !== 'string' || !GAME_ID_PATTERN.test(def.id)) {
    throw new GameDefError(
      'badId',
      `${JSON.stringify(def.id)} must match ${String(GAME_ID_PATTERN)}`,
    );
  }
  if (!isIntegerIn(def.protocolVersion, 1, 65535)) {
    throw new GameDefError(
      'badProtocolVersion',
      `${String(def.protocolVersion)} must be an integer in 1..65535`,
    );
  }
  const tickRate = def.tickRate ?? DEFAULT_TICK_RATE;
  if (!isIntegerIn(tickRate, MIN_TICK_RATE, MAX_TICK_RATE)) {
    throw new GameDefError(
      'badTickRate',
      `${String(tickRate)} must be an integer in ${MIN_TICK_RATE}..${MAX_TICK_RATE}`,
    );
  }
  const snapshotEvery = def.snapshotEvery ?? DEFAULT_SNAPSHOT_EVERY;
  if (!isIntegerIn(snapshotEvery, 1, MAX_SNAPSHOT_EVERY)) {
    throw new GameDefError(
      'badSnapshotEvery',
      `${String(snapshotEvery)} must be an integer in 1..${MAX_SNAPSHOT_EVERY}`,
    );
  }
  if (!isIntegerIn(def.seed, 0, 0xffffffff)) {
    throw new GameDefError('badSeed', `${String(def.seed)} must be a u32`);
  }

  const components = dedupeByIdentity<ComponentType<unknown>>([
    ...CORE_COMPONENTS,
    ...def.components,
  ]);
  const events = dedupeByIdentity<EventType<unknown>>([RegionChanged, ...def.events]);
  const messages = [...def.messages];
  checkUniqueNames(components, 'duplicateComponent');
  checkUniqueNames(events, 'duplicateEvent');
  checkUniqueNames(messages, 'duplicateMessage');
  checkUniqueNames(def.systems, 'duplicateSystem');

  if (components.length > MAX_GAME_COMPONENTS) {
    throw new GameDefError(
      'tooManyComponents',
      `${components.length} components (core included) exceed ${MAX_GAME_COMPONENTS}`,
    );
  }

  const input = def.input as Partial<GameDefInput<I>['input']> | undefined;
  if (input?.fieldNames?.[0] !== 'tick' || input.fields?.tick?.kind !== 'u32') {
    throw new GameDefError('inputLacksTick', 'the first input field must be tick: f.u32');
  }

  for (const c of components) checkInterpolation(c);

  return { tickRate, snapshotEvery, components, events, messages };
}

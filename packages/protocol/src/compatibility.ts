import { f, type FieldType } from './fields.ts';
import { DecodeError, EncodeError } from './errors.ts';
/** Build/deployment declarations; equality does not prove which code a peer executes. */
export interface CompatibilityDeclaration {
  readonly simulationRevision: string;
  readonly gameplayDigests: Readonly<Record<string, string>>;
}
export interface CompatibilityDescriptor {
  readonly descriptorVersion: number;
  readonly mode: 'declared' | 'schema-only';
  readonly gameId: string;
  readonly simulationRevision: string;
  readonly gameplayDigests: readonly { readonly name: string; readonly digest: string }[];
}

function bounded(value: string, maximum: number, label: string): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    new TextEncoder().encode(value).length > maximum
  ) {
    throw new RangeError(`Compatibility: ${label} must contain 1..${maximum} UTF-8 bytes`);
  }
}

/** Copies and freezes a bounded declaration. Omission explicitly means schema-only admission. */
export function createCompatibilityDescriptor(
  gameId: string,
  declaration?: CompatibilityDeclaration,
): CompatibilityDescriptor {
  bounded(gameId, 64, 'gameId');
  if (declaration !== undefined && Object.keys(declaration.gameplayDigests).length > 16)
    throw new RangeError('Compatibility: at most 16 gameplay digests');
  const gameplayDigests =
    declaration === undefined
      ? []
      : Object.entries(declaration.gameplayDigests)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([name, digest]) => {
            bounded(name, 64, 'digest name');
            bounded(digest, 128, 'digest value');
            return Object.freeze({ name, digest });
          });
  if (gameplayDigests.length > 16)
    throw new RangeError('Compatibility: at most 16 gameplay digests');
  if (declaration !== undefined) bounded(declaration.simulationRevision, 128, 'simulationRevision');
  return Object.freeze({
    descriptorVersion: 1,
    mode: declaration === undefined ? 'schema-only' : 'declared',
    gameId,
    simulationRevision: declaration?.simulationRevision ?? '',
    gameplayDigests: Object.freeze(gameplayDigests),
  });
}

/** Validates/copies an untrusted descriptor and enforces canonical ordering and mode semantics. */
export function copyCompatibilityDescriptor(
  value: CompatibilityDescriptor,
): CompatibilityDescriptor {
  if (value.descriptorVersion !== 1 || (value.mode !== 'declared' && value.mode !== 'schema-only'))
    throw new RangeError('Compatibility: unsupported descriptor version or mode');
  if (!Array.isArray(value.gameplayDigests) || value.gameplayDigests.length > 16)
    throw new RangeError('Compatibility: invalid digests');
  let previous = '';
  const entries: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const entry of value.gameplayDigests) {
    if (entry.name <= previous)
      throw new RangeError('Compatibility: digest names must be unique and sorted');
    previous = entry.name;
    entries[entry.name] = entry.digest;
  }
  if (
    value.mode === 'schema-only' &&
    (value.simulationRevision !== '' || value.gameplayDigests.length !== 0)
  )
    throw new RangeError('Compatibility: schema-only descriptor carries simulation declarations');
  return createCompatibilityDescriptor(
    value.gameId,
    value.mode === 'declared'
      ? { simulationRevision: value.simulationRevision, gameplayDigests: entries }
      : undefined,
  );
}

/** Actionable field names only; never includes digest values or gameplay data. */
export function compatibilityDifferences(
  expected: CompatibilityDescriptor,
  actual: CompatibilityDescriptor,
): string[] {
  const differences: string[] = [];
  for (const key of ['descriptorVersion', 'mode', 'gameId', 'simulationRevision'] as const)
    if (expected[key] !== actual[key]) differences.push(key);
  const left = new Map(expected.gameplayDigests.map((entry) => [entry.name, entry.digest]));
  const right = new Map(actual.gameplayDigests.map((entry) => [entry.name, entry.digest]));
  for (const name of [...new Set([...left.keys(), ...right.keys()])].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  ))
    if (left.get(name) !== right.get(name)) differences.push(`gameplayDigests.${name}`);
  return differences;
}

/** Canonical JSON-like data: object order ignored, array order retained, signed zero retained. */
export function canonicalGameplayData(value: unknown): string {
  const ancestors = new Set<object>();
  function encode(item: unknown): string {
    if (item === null) return 'null';
    if (typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new TypeError('Gameplay data must contain finite numbers');
      return Object.is(item, -0) ? '-0' : JSON.stringify(item);
    }
    if (typeof item !== 'object')
      throw new TypeError('Gameplay data cannot contain undefined, functions, symbols or bigint');
    if (ancestors.has(item)) throw new TypeError('Gameplay data cannot contain cycles');
    if (
      !Array.isArray(item) &&
      Object.getPrototypeOf(item) !== Object.prototype &&
      Object.getPrototypeOf(item) !== null
    )
      throw new TypeError('Gameplay data must use plain objects');
    if (Object.getOwnPropertySymbols(item).length > 0)
      throw new TypeError('Gameplay data cannot contain symbol keys');
    const descriptors = Object.getOwnPropertyDescriptors(item);
    for (const descriptor of Object.values(descriptors))
      if (descriptor.get !== undefined || descriptor.set !== undefined)
        throw new TypeError('Gameplay data cannot contain accessors');
    if (
      Array.isArray(item) &&
      Object.keys(item).some((key) => !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length)
    )
      throw new TypeError('Gameplay arrays cannot contain extra properties');
    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        const entries: string[] = [];
        for (let i = 0; i < item.length; i++) {
          if (!Object.hasOwn(item, i))
            throw new TypeError('Gameplay data cannot contain sparse arrays');
          entries.push(encode(item[i]));
        }
        return `[${entries.join(',')}]`;
      }
      return `{${Object.keys(item)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
        .map((key) => `${JSON.stringify(key)}:${encode((item as Record<string, unknown>)[key])}`)
        .join(',')}}`;
    } finally {
      ancestors.delete(item);
    }
  }
  return encode(value);
}

/** Build-time helper; admission compares precomputed identifiers synchronously. */
export async function hashGameplayData(value: unknown): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalGameplayData(value)),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const wireDescriptor = f.struct({
  descriptorVersion: f.u8,
  mode: f.str(11),
  gameId: f.str(64),
  simulationRevision: f.str(128),
  gameplayDigests: f.array(f.struct({ name: f.str(64), digest: f.str(128) }), 16),
});

/** Bounded wire representation, decoded descriptors own immutable copies. */
export const CompatibilityField: FieldType<CompatibilityDescriptor> = Object.freeze<
  FieldType<CompatibilityDescriptor>
>({
  kind: 'struct',
  descriptor: wireDescriptor.descriptor,
  allocates: true,
  numeric: false,
  create: () => createCompatibilityDescriptor('schema-only'),
  copy: (value) => copyCompatibilityDescriptor(value),
  encode(writer, value) {
    let checked: CompatibilityDescriptor;
    try {
      checked = copyCompatibilityDescriptor(value);
    } catch (error) {
      throw new EncodeError('range', String(error));
    }
    wireDescriptor.encode(writer, {
      ...checked,
      gameplayDigests: checked.gameplayDigests.map((entry) => ({ ...entry })),
    });
  },
  decode(reader) {
    const offset = reader.offset;
    const value = wireDescriptor.decode(reader);
    try {
      if (value.mode !== 'declared' && value.mode !== 'schema-only')
        throw new RangeError('Compatibility: unsupported mode');
      return copyCompatibilityDescriptor({ ...value, mode: value.mode });
    } catch (error) {
      throw new DecodeError('range', offset, String(error));
    }
  },
  decodeInto(reader) {
    return this.decode(reader);
  },
});

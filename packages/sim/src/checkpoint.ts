/** Exact diagnostic state uses tagged data, distinct from quantized protocol encoding. */
type Tagged = [string, unknown?];
const encoder = new TextEncoder();
export const MAX_EXACT_STATE_BYTES = 64 * 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });

/** Canonical tags preserve undefined, array order, signed zero and all finite JS number bits. */
export function encodeExactState(value: unknown): Uint8Array {
  const ancestors = new Set<object>();
  let nodes = 0;
  let estimatedBytes = 0;
  const numberBytes = new DataView(new ArrayBuffer(8));
  function tag(input: unknown, path: string, depth: number): Tagged {
    if (++nodes > 1_000_000) throw new TypeError('Checkpoint node budget exceeded');
    if (typeof input === 'string') estimatedBytes += input.length * 4;
    else estimatedBytes += 24;
    if (estimatedBytes > MAX_EXACT_STATE_BYTES)
      throw new TypeError('Checkpoint byte budget exceeded');
    if (depth > 128) throw new TypeError(`${path}: checkpoint nesting exceeds 128`);
    if (input === undefined) return ['undefined'];
    if (input === null) return ['null'];
    if (typeof input === 'boolean') return ['boolean', input];
    if (typeof input === 'string') return ['string', input];
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) throw new TypeError(`${path}: non-finite checkpoint number`);
      numberBytes.setFloat64(0, input, false);
      return [
        'number',
        Array.from(new Uint8Array(numberBytes.buffer), (byte) =>
          byte.toString(16).padStart(2, '0'),
        ).join(''),
      ];
    }
    if (typeof input !== 'object')
      throw new TypeError(`${path}: unsupported checkpoint ${typeof input}; register a serializer`);
    if (ancestors.has(input)) throw new TypeError(`${path}: cyclic checkpoint state`);
    ancestors.add(input);
    try {
      if (Object.getOwnPropertySymbols(input).length !== 0)
        throw new TypeError(`${path}: symbol checkpoint keys unsupported`);
      // Buffer is deliberately canonicalized as bytes, not as its Node-specific subclass.
      if (input instanceof Uint8Array) {
        nodes += input.byteLength;
        if (nodes > 1_000_000) throw new TypeError('Checkpoint byte-array node budget exceeded');
        if (
          Object.getOwnPropertyNames(input).some(
            (key) => !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= input.length,
          )
        )
          throw new TypeError(`${path}: extra byte-array checkpoint properties unsupported`);
        if (input.byteLength > MAX_EXACT_STATE_BYTES / 4)
          throw new TypeError('Checkpoint byte budget exceeded');
        estimatedBytes += input.byteLength * 4;
        if (estimatedBytes > MAX_EXACT_STATE_BYTES)
          throw new TypeError('Checkpoint byte budget exceeded');
        return ['bytes', Array.from(input)];
      }
      if (Object.getOwnPropertySymbols(input).length !== 0)
        throw new TypeError(`${path}: symbol checkpoint keys unsupported`);
      for (const key of Object.getOwnPropertyNames(input)) {
        estimatedBytes += key.length * 4;
        if (estimatedBytes > MAX_EXACT_STATE_BYTES)
          throw new TypeError('Checkpoint key byte budget exceeded');
        const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
        if (Array.isArray(input) && key === 'length') continue;
        if (!('value' in descriptor) || !descriptor.enumerable)
          throw new TypeError(
            `${path}.${key}: accessors/nonenumerable checkpoint fields unsupported`,
          );
      }
      if (Array.isArray(input)) {
        if (
          Object.keys(input).length !== input.length ||
          input.some((_, index) => !Object.hasOwn(input, index))
        )
          throw new TypeError(`${path}: sparse arrays or extra array properties unsupported`);
        for (let index = 0; index < input.length; index++)
          if (!Object.hasOwn(input, index))
            throw new TypeError(`${path}: sparse arrays unsupported`);
        return [
          'array',
          Array.from(input, (item, index) => tag(item, `${path}[${index}]`, depth + 1)),
        ];
      }
      if (
        Object.getPrototypeOf(input) !== Object.prototype &&
        Object.getPrototypeOf(input) !== null
      )
        throw new TypeError(`${path}: unsupported checkpoint object; register a serializer`);
      return [
        'object',
        Object.keys(input)
          .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
          .map((key) => [key, tag(Reflect.get(input, key), `${path}.${key}`, depth + 1)]),
      ];
    } finally {
      ancestors.delete(input);
    }
  }
  const bytes = encoder.encode(JSON.stringify(tag(value, '$', 0)));
  if (bytes.byteLength > MAX_EXACT_STATE_BYTES)
    throw new TypeError('Checkpoint byte budget exceeded');
  return bytes;
}

/** Validates tags before producing detached plain data. */
export function decodeExactState(bytes: Uint8Array): unknown {
  if (bytes.byteLength > MAX_EXACT_STATE_BYTES)
    throw new TypeError('Checkpoint input byte budget exceeded');
  const root: unknown = JSON.parse(decoder.decode(bytes));
  let count = 0;
  function untag(raw: unknown, depth: number): unknown {
    if (
      ++count > 1_000_000 ||
      depth > 128 ||
      !Array.isArray(raw) ||
      raw.length < 1 ||
      raw.length > 2
    )
      throw new TypeError('Invalid or oversized exact-state encoding');
    const [kind, value] = raw;
    switch (kind) {
      case 'undefined':
        if (raw.length === 1) return undefined;
        break;
      case 'null':
        if (raw.length === 1) return null;
        break;
      case 'boolean':
        if (typeof value === 'boolean') return value;
        break;
      case 'string':
        if (typeof value === 'string') return value;
        break;
      case 'number': {
        if (typeof value !== 'string' || !/^[0-9a-f]{16}$/.test(value)) break;
        const buffer = new Uint8Array(8);
        for (let i = 0; i < 8; i++) buffer[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
        const number = new DataView(buffer.buffer).getFloat64(0, false);
        if (!Number.isFinite(number)) break;
        return number;
      }
      case 'bytes':
        if (Array.isArray(value)) {
          count += value.length;
          if (count > 1_000_000) throw new TypeError('Checkpoint byte-array node budget exceeded');
        }
        if (
          Array.isArray(value) &&
          value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
        )
          return new Uint8Array(value);
        break;
      case 'array':
        if (Array.isArray(value)) return value.map((item) => untag(item, depth + 1));
        break;
      case 'object': {
        if (!Array.isArray(value)) break;
        const result: Record<string, unknown> = {};
        let previous: string | undefined;
        for (const entry of value) {
          if (
            !Array.isArray(entry) ||
            entry.length !== 2 ||
            typeof entry[0] !== 'string' ||
            (previous !== undefined && entry[0] <= previous)
          )
            throw new TypeError('Invalid exact-state object keys');
          previous = entry[0];
          Object.defineProperty(result, entry[0], {
            value: untag(entry[1], depth + 1),
            enumerable: true,
            configurable: true,
            writable: true,
          });
        }
        return result;
      }
    }
    throw new TypeError(`Invalid exact-state tag ${String(kind)}`);
  }
  return untag(root, 0);
}

/** Detached validated data; deliberately does not invoke JSON or wire-schema quantization. */
export function cloneExactState<T>(value: T): T {
  return decodeExactState(encodeExactState(value)) as T;
}

export async function fullStateDigest(value: unknown): Promise<string> {
  const bytes = encodeExactState(value);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function structuralType(value: unknown): string {
  if (value === null) return 'null';
  if (value instanceof Uint8Array) return 'bytes';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

export interface StateDifference {
  readonly path: string;
  readonly expected: unknown;
  readonly actual: unknown;
}
/** Deterministic first-field diagnostic; Object.is distinguishes signed zero and missing values. */
export function firstStateDifference(
  expected: unknown,
  actual: unknown,
  path = '$',
): StateDifference | null {
  if (Object.is(expected, actual)) return null;
  if (structuralType(expected) !== structuralType(actual))
    return {
      path: `${path} (type ${structuralType(expected)} vs ${structuralType(actual)})`,
      expected,
      actual,
    };
  if (
    expected !== null &&
    actual !== null &&
    typeof expected === 'object' &&
    typeof actual === 'object'
  ) {
    if (Array.isArray(expected) !== Array.isArray(actual)) return { path, expected, actual };
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    for (const key of keys) {
      if (Object.hasOwn(expected, key) !== Object.hasOwn(actual, key))
        return {
          path: `${path}.${key}`,
          expected: Reflect.get(expected, key),
          actual: Reflect.get(actual, key),
        };
      const difference = firstStateDifference(
        Reflect.get(expected, key),
        Reflect.get(actual, key),
        `${path}.${key}`,
      );
      if (difference !== null) return difference;
    }
    if (Array.isArray(expected) && Array.isArray(actual) && expected.length !== actual.length)
      return { path: `${path}.length`, expected: expected.length, actual: actual.length };
    return null;
  }
  return { path, expected, actual };
}

export interface StoreCheckpoint {
  readonly name: string;
  readonly entities: readonly number[];
  readonly values: readonly unknown[];
  readonly versions: readonly number[];
  readonly removedAt: readonly number[];
}
export interface WorldCheckpoint {
  readonly version: 1;
  readonly tick: number;
  readonly capacity: number;
  readonly highWater: number;
  readonly live: number;
  readonly generations: readonly number[];
  readonly allocated: readonly number[];
  readonly pendingFlags: readonly number[];
  readonly freeList: readonly number[];
  readonly pendingDestroy: readonly number[];
  readonly stores: readonly StoreCheckpoint[];
}

/** Registered game-owned state cannot silently fall back to JSON or capture closures. */
export interface StateSerializer<T = unknown> {
  readonly name: string;
  readonly version: number;
  capture(): T;
  validate(value: unknown): void;
  restore(value: T): void;
}
export interface SerializedState {
  readonly name: string;
  readonly version: number;
  readonly value: unknown;
}
export function captureRegisteredState(serializers: readonly StateSerializer[]): SerializedState[] {
  const names = new Set<string>();
  return serializers
    .map((serializer) => {
      if (
        names.has(serializer.name) ||
        serializer.name.length === 0 ||
        !Number.isSafeInteger(serializer.version) ||
        serializer.version < 1
      )
        throw new TypeError('Invalid or duplicate checkpoint serializer');
      names.add(serializer.name);
      const value = cloneExactState(serializer.capture());
      serializer.validate(value);
      return { name: serializer.name, version: serializer.version, value };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
export function validateRegisteredState(
  serializers: readonly StateSerializer[],
  states: readonly SerializedState[],
): void {
  if (serializers.length !== states.length)
    throw new TypeError('Checkpoint game serializer set mismatch');
  const byName = new Map(serializers.map((serializer) => [serializer.name, serializer]));
  const seen = new Set<string>();
  for (const state of states) {
    const serializer = byName.get(state.name);
    if (serializer === undefined || serializer.version !== state.version || seen.has(state.name))
      throw new TypeError(`Checkpoint serializer ${state.name} version mismatch or missing`);
    seen.add(state.name);
    serializer.validate(state.value);
  }
}

export interface DigestNode {
  readonly path: string;
  readonly digest: string;
}
/** Optional bounded hierarchy for diagnostics; not a per-client replication operation. */
export async function hierarchicalStateDigests(
  value: unknown,
  options: { maxNodes?: number; maxDepth?: number } = {},
): Promise<{ readonly nodes: readonly DigestNode[]; readonly truncated: boolean }> {
  const maxNodes = options.maxNodes ?? 256;
  const maxDepth = options.maxDepth ?? 6;
  if (
    !Number.isInteger(maxNodes) ||
    maxNodes < 1 ||
    maxNodes > 4096 ||
    !Number.isInteger(maxDepth) ||
    maxDepth < 0 ||
    maxDepth > 32
  )
    throw new RangeError('Invalid hierarchical digest budget');
  const nodes: DigestNode[] = [];
  let truncated = false;
  async function visit(item: unknown, path: string, depth: number): Promise<void> {
    if (nodes.length >= maxNodes) {
      truncated = true;
      return;
    }
    nodes.push({ path, digest: await fullStateDigest(item) });
    if (item === null || typeof item !== 'object' || item instanceof Uint8Array) return;
    const keys = Object.keys(item).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (depth >= maxDepth) {
      if (keys.length > 0) truncated = true;
      return;
    }
    for (const key of keys) {
      if (nodes.length >= maxNodes) {
        truncated = true;
        break;
      }
      await visit(Reflect.get(item, key), `${path}.${key}`, depth + 1);
    }
  }
  await visit(value, '$', 0);
  return { nodes, truncated };
}

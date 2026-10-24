import type { FieldMap, FieldType } from '@conduit/protocol';
/** Recursive immutable view of schema data, including optional fields and arrays. */
export type DeepReadonly<T> = T extends object
  ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : T;

/** Cached recursive proxy. Never freezes the live backing value. */
export function guardView<T>(
  value: T,
  check: () => void,
  writable: boolean,
  cache = new WeakMap<object, object>(),
): T {
  if (value === null || typeof value !== 'object') return value;
  const existing = cache.get(value);
  if (existing !== undefined) return existing as T;
  const clone = (input: unknown): unknown => {
    if (input === null || typeof input !== 'object') return input;
    if (Array.isArray(input)) return input.map(clone);
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(input)) result[key] = clone(Reflect.get(input, key));
    return result;
  };
  const reject = (): never => {
    throw new TypeError('Component read is immutable');
  };
  const proxy = new Proxy(value, {
    get(target, key, receiver) {
      check();
      return guardView(Reflect.get(target, key, receiver), check, writable, cache);
    },
    set(target, key, next) {
      check();
      if (!writable) reject();
      return Reflect.set(target, key, clone(next));
    },
    deleteProperty(target, key) {
      check();
      if (!writable) reject();
      return Reflect.deleteProperty(target, key);
    },
    defineProperty(target, key, descriptor) {
      check();
      if (!writable) reject();
      return Reflect.defineProperty(
        target,
        key,
        'value' in descriptor ? { ...descriptor, value: clone(descriptor.value) } : descriptor,
      );
    },
    getOwnPropertyDescriptor(target, key) {
      check();
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      if (descriptor === undefined || !('value' in descriptor)) return descriptor;
      return { ...descriptor, value: guardView(descriptor.value, check, writable, cache) };
    },
    setPrototypeOf: reject,
    preventExtensions: reject,
  });
  cache.set(value, proxy);
  return proxy;
}

/** Fast valid-data traversal: no path strings, key arrays or visited-set allocation. */
function finiteData(value: unknown, depth: number): boolean {
  if (typeof value === 'number') return Number.isFinite(value);
  if (value === null || typeof value !== 'object') return true;
  if (depth >= 64) return false;
  for (const key in value) {
    if (Object.hasOwn(value, key) && !finiteData(Reflect.get(value, key), depth + 1)) return false;
  }
  return true;
}

function explainInvalid(value: unknown, path: string, depth: number): never {
  if (depth >= 64) throw new TypeError(`${path}: cyclic or excessively deep component data`);
  if (value !== null && typeof value === 'object') {
    for (const key in value) {
      if (Object.hasOwn(value, key)) {
        const child = Reflect.get(value, key);
        if (!finiteData(child, depth + 1)) explainInvalid(child, `${path}.${key}`, depth + 1);
      }
    }
  }
  throw new TypeError(`${path}: expected finite number`);
}

/** Numeric safety check independent of game-specific domain rules. */
export function assertFiniteData(value: unknown, path: string): void {
  if (!finiteData(value, 0)) explainInvalid(value, path, 0);
}

/** Precompile schema-field checks once; scalar/vector writes avoid reflective key enumeration. */
export function compileFiniteDataCheck(name: string, fields: FieldMap): (value: unknown) => void {
  type Check = (value: unknown) => boolean;
  const fieldNames = Object.keys(fields);
  const numericNames = fieldNames.filter(
    (key) => fields[key]!.numeric || fields[key]!.kind === 'entity',
  );
  const otherNames = fieldNames.filter(
    (key) => !fields[key]!.numeric && fields[key]!.kind !== 'entity',
  );
  const checks: Check[] = otherNames.map((key) => {
    const type = fields[key] as FieldType<unknown>;
    if (type.kind === 'vec2')
      return (value) => {
        if (value === null || typeof value !== 'object') return false;
        const v = value as { x: number; y: number };
        return Number.isFinite(v.x) && Number.isFinite(v.y);
      };
    if (type.kind === 'vec3')
      return (value) => {
        if (value === null || typeof value !== 'object') return false;
        const v = value as { x: number; y: number; z: number };
        return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
      };
    if (type.kind === 'quat')
      return (value) => {
        if (value === null || typeof value !== 'object') return false;
        const v = value as { x: number; y: number; z: number; w: number };
        return (
          Number.isFinite(v.x) &&
          Number.isFinite(v.y) &&
          Number.isFinite(v.z) &&
          Number.isFinite(v.w)
        );
      };
    return (value) => finiteData(value, 0);
  });
  const paths = otherNames.map((key) => `${name}.${key}`);
  const numericPaths = numericNames.map((key) => `${name}.${key}`);
  return (value) => {
    if (value === null || typeof value !== 'object')
      throw new TypeError(`${name}: invalid component shape`);
    const fields = value as Record<string, unknown>;
    // Keep Number.isFinite intrinsic at this call site: passing unboxed scalar fields through
    // a generic callback otherwise boxes one HeapNumber per checked double in V8.
    for (let i = 0; i < numericNames.length; i++) {
      if (!Number.isFinite(fields[numericNames[i]!])) {
        assertFiniteData(fields[numericNames[i]!], numericPaths[i]!);
        throw new TypeError(`${numericPaths[i]}: invalid finite component value`);
      }
    }
    for (let i = 0; i < otherNames.length; i++) {
      const current = fields[otherNames[i]!];
      if (!checks[i]!(current)) {
        assertFiniteData(current, paths[i]!);
        throw new TypeError(`${paths[i]}: invalid finite component value`);
      }
    }
  };
}

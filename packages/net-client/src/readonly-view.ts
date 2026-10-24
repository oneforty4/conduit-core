/** Immutable schema values owned by the replica/event layer; no caller-owned objects are frozen. */
export function freezeOwned<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) freezeOwned(Reflect.get(value, key));
    Object.freeze(value);
  }
  return value;
}

/** Live read-only map facade; Map mutators and the backing map are never exposed. */
export function readonlyMapView<K, V, R>(map: Map<K, V>, read: (value: V) => R): ReadonlyMap<K, R> {
  const view: ReadonlyMap<K, R> = Object.freeze({
    get size() {
      return map.size;
    },
    get: (key: K) => {
      const value = map.get(key);
      return value === undefined ? undefined : read(value);
    },
    has: (key: K) => map.has(key),
    *keys() {
      yield* map.keys();
      return undefined;
    },
    *values() {
      for (const value of map.values()) yield read(value);
      return undefined;
    },
    *entries() {
      for (const [key, value] of map) yield [key, read(value)] as [K, R];
      return undefined;
    },
    [Symbol.iterator]() {
      return this.entries();
    },
    forEach(callback: (value: R, key: K, map: ReadonlyMap<K, R>) => void, thisArg?: unknown) {
      for (const [key, value] of map) callback.call(thisArg, read(value), key, view);
    },
  });
  return view;
}

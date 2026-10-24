type AnyListener = (event: never) => void;

/**
 * Minimal typed event emitter. `Events` maps event names to payload types. Listeners run in
 * registration order on a snapshot, so subscribing or unsubscribing during `emit` affects only later
 * emits. A throwing listener does not stop the others; its error goes to `onError` (default
 * `console.error`).
 */
export class Emitter<Events extends object> {
  private readonly listeners = new Map<keyof Events, AnyListener[]>();
  private readonly onError: (error: unknown) => void;

  constructor(onError?: (error: unknown) => void) {
    this.onError = onError ?? ((error) => console.error(error));
  }

  /** Adds `cb`; the returned function removes this registration (idempotent). */
  on<K extends keyof Events>(event: K, cb: (payload: Events[K]) => void): () => void {
    const list = this.listeners.get(event) ?? [];
    this.listeners.set(event, [...list, cb as AnyListener]);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.off(event, cb);
    };
  }

  /** Removes one registration of `cb` for `event`, if any. */
  off<K extends keyof Events>(event: K, cb: (payload: Events[K]) => void): void {
    const list = this.listeners.get(event);
    if (list === undefined) return;
    const i = list.indexOf(cb as AnyListener);
    if (i < 0) return;
    const next = [...list.slice(0, i), ...list.slice(i + 1)];
    if (next.length > 0) this.listeners.set(event, next);
    else this.listeners.delete(event);
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const list = this.listeners.get(event);
    if (list === undefined) return;
    for (const cb of list) {
      try {
        (cb as (payload: Events[K]) => void)(payload);
      } catch (error) {
        this.onError(error);
      }
    }
  }

  /** Number of listeners registered for `event`. */
  listenerCount(event: keyof Events): number {
    return this.listeners.get(event)?.length ?? 0;
  }
}

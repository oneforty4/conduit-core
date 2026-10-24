/** Opaque presentation effects. Simulation replay must not call begin or perform external side effects. */
export interface SpeculativeEffectHooks<T> {
  onError?(error: unknown): void;
  begin(id: string, value: T): void;
  confirm(id: string, value: T): void;
  cancel(id: string, value: T): void;
}

/** Bounded exactly-once lifecycle within a connection epoch. Old IDs cannot be reused in that epoch. */
export class SpeculativeEffects<T> {
  private readonly entries = new Map<
    string,
    { value: T; state: 'pending' | 'confirmed' | 'cancelled' }
  >();
  private readonly hooks: SpeculativeEffectHooks<T>;
  readonly capacity: number;
  private epoch = 0;
  private rejected = 0;
  constructor(hooks: SpeculativeEffectHooks<T>, capacity = 128) {
    this.hooks = hooks;
    this.capacity = capacity;
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 4096)
      throw new RangeError('SpeculativeEffects: capacity must be in 1..4096');
  }
  begin(id: string, value: T): boolean {
    if (id.length === 0 || id.length > 128 || this.entries.has(id)) return false;
    // Retaining tombstones prevents replay duplicates. Full history rejects new speculation until explicit reset.
    if (this.entries.size >= this.capacity) {
      this.rejected++;
      return false;
    }
    this.entries.set(id, { value, state: 'pending' });
    this.notify(() => this.hooks.begin(id, value));
    return true;
  }
  confirm(id: string): boolean {
    return this.resolve(id, 'confirmed');
  }
  cancel(id: string): boolean {
    return this.resolve(id, 'cancelled');
  }
  reset(): void {
    const pending = [...this.entries].filter(([, entry]) => entry.state === 'pending');
    this.entries.clear();
    this.epoch++;
    for (const [id, entry] of pending) this.notify(() => this.hooks.cancel(id, entry.value));
  }
  /** Caller declares a new monotonic retention epoch; old IDs are no longer deduplicated. */
  advanceEpoch(epoch: number): void {
    if (!Number.isSafeInteger(epoch) || epoch <= this.epoch)
      throw new RangeError('SpeculativeEffects: epoch must advance monotonically');
    this.reset();
    this.epoch = epoch;
  }
  stats() {
    return {
      epoch: this.epoch,
      retained: this.entries.size,
      pending: [...this.entries.values()].filter((entry) => entry.state === 'pending').length,
      rejected: this.rejected,
      pressure: this.entries.size >= this.capacity,
    };
  }
  private notify(callback: () => void): void {
    try {
      callback();
    } catch (error) {
      try {
        this.hooks.onError?.(error);
      } catch {
        /* Notification failure cannot interrupt lifecycle. */
      }
    }
  }
  get size(): number {
    return this.entries.size;
  }
  private resolve(id: string, state: 'confirmed' | 'cancelled'): boolean {
    const entry = this.entries.get(id);
    if (entry === undefined || entry.state !== 'pending') return false;
    entry.state = state;
    if (state === 'confirmed') this.notify(() => this.hooks.confirm(id, entry.value));
    else this.notify(() => this.hooks.cancel(id, entry.value));
    return true;
  }
}

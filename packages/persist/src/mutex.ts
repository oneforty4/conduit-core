/** FIFO async lock (docs/persist.md 1.9), implemented as a promise chain. */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;

  /** True from a `run()` call until its `fn` settles, i.e. while any run is executing or waiting. */
  get locked(): boolean {
    return this.pending > 0;
  }

  /** Runs `fn` once every earlier `run()` has settled; resolves or rejects with `fn`'s outcome. */
  async run<T>(fn: () => Promise<T> | T): Promise<T> {
    const prev = this.tail;
    let release = (): void => {};
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.pending++;
    try {
      await prev; // never rejects: every link is resolved by `release`
      return await fn();
    } finally {
      this.pending--;
      release();
    }
  }
}

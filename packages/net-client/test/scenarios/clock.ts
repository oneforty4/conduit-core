export type Lane = 'network' | 'server' | 'client';
export interface Stall {
  lane: Lane;
  at: number;
  duration: number;
}
interface Task {
  id: number;
  at: number;
  lane: Lane;
  label: string;
  fn: () => void;
}

/** Deterministic test-only event loop. Client stalls hold messages AND timers. */
export class ScenarioClock {
  now = 0;
  private sequence = 0;
  private tasks: Task[] = [];
  readonly schedule: { id: number; at: number; lane: Lane; label: string }[] = [];
  constructor(
    readonly stalls: readonly Stall[] = [],
    readonly maxTasks = 100_000,
  ) {}

  at(at: number, lane: Lane, label: string, fn: () => void): number {
    if (this.schedule.length >= this.maxTasks) throw new Error('scenario schedule limit exceeded');
    if (!Number.isFinite(at) || at < this.now) throw new RangeError('invalid deadline');
    // Iterate: a delayed task can land inside a later/overlapping stall.
    for (;;) {
      const stall = this.stalls.find(
        (s) => s.lane === lane && at >= s.at && at < s.at + s.duration,
      );
      if (!stall) break;
      at = stall.at + stall.duration;
    }
    const id = ++this.sequence;
    this.tasks.push({ id, at, lane, label, fn });
    this.schedule.push({ id, at, lane, label });
    return id;
  }

  timers(lane: Lane, quantum = 0) {
    return {
      now: () => this.now,
      setTimeout: (fn: () => void, ms: number): number => {
        const at = this.now + Math.max(0, ms);
        return this.at(quantum > 0 ? Math.ceil(at / quantum) * quantum : at, lane, 'timer', fn);
      },
      clearTimeout: (id: unknown): void => {
        this.tasks = this.tasks.filter((t) => t.id !== id);
      },
    };
  }

  run(until: number): void {
    if (!Number.isFinite(until) || until < this.now) throw new RangeError('invalid horizon');
    let work = 0;
    for (;;) {
      this.tasks.sort((a, b) => a.at - b.at || a.id - b.id);
      const task = this.tasks[0];
      if (!task || task.at > until) break;
      if (++work > this.maxTasks) throw new Error('scenario work limit exceeded');
      this.tasks.shift();
      this.now = task.at;
      task.fn();
    }
    this.now = until;
  }
}

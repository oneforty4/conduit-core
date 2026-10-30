import {
  AckSchema,
  type ByteWriter,
  CoreKind,
  defineInput,
  defineMessage,
  f,
  FrameWriter,
  HelloSchema,
  type InputPayload,
  KickedSchema,
  LeaveSchema,
  type MessageHeader,
  nextSeq,
  PingSchema,
  PongSchema,
  readFrame,
  ReadySchema,
  RegionLoadStateSchema,
  RegionSetSchema,
  RejectedSchema,
  type Schema,
  SchemaRegistry,
  SessionStateSchema,
  SpawnedSchema,
  WelcomeSchema,
  type WelcomePayload,
  encodeSnapshot,
  type SnapshotData,
  type EventsData,
  encodeEvents,
} from '@conduit/protocol';
import { CORE_COMPONENTS, defineComponent, type ComponentType } from '@conduit/sim';
import { GridWorld } from '@conduit/world';
import type { ClientGameDef, ClientTimers, MemoryLink } from '../src/index.ts';

/** Deterministic timers and clock: nothing runs until `advance`. */
export class ManualTimers implements ClientTimers {
  now = 1000;
  private nextId = 1;
  private seq = 0;
  private readonly tasks = new Map<
    number,
    { at: number; seq: number; interval: number | null; fn: () => void }
  >();

  readonly nowFn = (): number => this.now;

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.now + Math.max(0, ms), seq: this.seq++, interval: null, fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.tasks.delete(handle as number);
  }

  setInterval(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    const interval = Math.max(1, ms);
    this.tasks.set(id, { at: this.now + interval, seq: this.seq++, interval, fn });
    return id;
  }

  clearInterval(handle: unknown): void {
    this.tasks.delete(handle as number);
  }

  /** Runs every task due within `ms`, in time order, moving `now` to each; then `now += ms`. */
  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      let bestId = -1;
      let best: { at: number; seq: number } | null = null;
      for (const [id, task] of this.tasks) {
        if (task.at > target) continue;
        if (best === null || task.at < best.at || (task.at === best.at && task.seq < best.seq)) {
          best = task;
          bestId = id;
        }
      }
      if (best === null) break;
      const task = this.tasks.get(bestId)!;
      this.now = Math.max(this.now, task.at);
      if (task.interval === null) this.tasks.delete(bestId);
      else {
        task.at += task.interval;
        task.seq = this.seq++;
      }
      task.fn();
    }
    this.now = Math.max(this.now, target);
  }

  /** Runs everything due now, including tasks those schedule for now. */
  flush(): void {
    this.advance(0);
  }

  pending(): number {
    return this.tasks.size;
  }
}

export const TestInput = defineInput({ tick: f.u32, throttle: f.i8, buttons: f.u8 });
export const Tag = defineComponent('Tag', { label: f.str(16), n: f.u16 });
export const Chat = defineMessage('Chat', 'both', { text: f.str(64) });
export const Notice = defineMessage('Notice', 's2c', { text: f.str(64) });
export const Shout = defineMessage('Shout', 'c2s', { text: f.str(64) });

export const TEST_COMPONENTS: readonly ComponentType<unknown>[] = [...CORE_COMPONENTS, Tag];

export function testRegistry(): SchemaRegistry {
  return new SchemaRegistry({
    components: TEST_COMPONENTS,
    messages: [Chat, Notice, Shout],
    events: [],
    input: TestInput,
  });
}

export function testGame(registry: SchemaRegistry = testRegistry()): ClientGameDef {
  return {
    id: 'test-game',
    protocolVersion: 7,
    tickRate: 60,
    snapshotEvery: 3,
    registry,
    input: registry.input,
    components: TEST_COMPONENTS,
    world: (seed) => new GridWorld({ cellSize: 100, cols: 4, rows: 4, worldSeed: seed }),
  };
}

export interface ClientMessage {
  header: MessageHeader;
  name: string;
  payload: unknown;
}

const C2S_SCHEMAS: Record<number, readonly [string, Schema<unknown>]> = {
  [CoreKind.Hello]: ['Hello', HelloSchema as Schema<unknown>],
  [CoreKind.Ready]: ['Ready', ReadySchema as Schema<unknown>],
  [CoreKind.Ack]: ['Ack', AckSchema as Schema<unknown>],
  [CoreKind.Ping]: ['Ping', PingSchema as Schema<unknown>],
  [CoreKind.RegionLoadState]: ['RegionLoadState', RegionLoadStateSchema as Schema<unknown>],
  [CoreKind.Leave]: ['Leave', LeaveSchema as Schema<unknown>],
};

/** Decodes a client frame into messages (an Ack may ride with an Input or a Ping, docs/net.md B.6). */
export function decodeClientFrame(buf: Uint8Array, registry: SchemaRegistry): ClientMessage[] {
  const out: ClientMessage[] = [];
  readFrame(buf, (header, r) => {
    if (header.kind === CoreKind.Input) {
      const schema = registry.message(CoreKind.Input)!.schema as Schema<InputPayload>;
      out.push({ header, name: 'Input', payload: schema.decode(r) });
      return;
    }
    const core = C2S_SCHEMAS[header.kind];
    if (core !== undefined) {
      out.push({ header, name: core[0], payload: core[1].decode(r) });
      return;
    }
    const def = registry.message(header.kind);
    if (def === undefined) throw new Error(`unknown client message kind ${header.kind}`);
    out.push({ header, name: def.name, payload: def.schema.decode(r) });
  });
  return out;
}

/** A hand-driven server end: records decoded client messages and sends scripted server frames. */
export class ScriptedServer {
  readonly link: MemoryLink;
  readonly registry: SchemaRegistry;
  readonly received: ClientMessage[] = [];
  /** The names of each frame's messages, frame by frame. */
  readonly frames: string[][] = [];
  closed: { code: number; reason: string } | null = null;
  private seq = 0;
  private readonly fw = new FrameWriter();

  constructor(link: MemoryLink, registry: SchemaRegistry) {
    this.link = link;
    this.registry = registry;
    link.onMessage((buf) => {
      const messages = decodeClientFrame(buf, registry);
      this.received.push(...messages);
      this.frames.push(messages.map((m) => m.name));
    });
    link.onClose((code, reason) => {
      this.closed = { code, reason };
    });
  }

  names(): string[] {
    return this.received.map((m) => m.name);
  }

  last(name: string): ClientMessage | undefined {
    return this.received.filter((m) => m.name === name).at(-1);
  }

  all(name: string): ClientMessage[] {
    return this.received.filter((m) => m.name === name);
  }

  /** Sends one frame holding the given messages. */
  frame(
    messages: {
      kind: number;
      tick?: number;
      encode: (w: ByteWriter) => void;
    }[],
  ): void {
    this.fw.begin();
    for (const m of messages) {
      this.fw.message(m.kind, m.tick ?? 0, this.seq, m.encode);
      this.seq = nextSeq(this.seq);
    }
    this.link.send(this.fw.finish());
  }

  sendRaw(buf: Uint8Array): void {
    this.link.send(buf);
  }

  send<T>(kind: number, schema: Schema<T>, payload: T, tick = 0): void {
    this.frame([{ kind, tick, encode: (w) => schema.encode(w, payload) }]);
  }

  welcome(overrides: Partial<WelcomePayload> = {}): WelcomePayload {
    const w: WelcomePayload = {
      playerId: 2,
      reconnectToken: 'tok-abc',
      simTickRate: 60,
      snapshotEvery: 3,
      serverTick: 120,
      serverTimeMs: 2000,
      worldSeed: 99,
      ...overrides,
    };
    this.send(CoreKind.Welcome, WelcomeSchema, w, w.serverTick);
    return w;
  }

  rejected(reason: number, detail: string): void {
    this.send(CoreKind.Rejected, RejectedSchema, { reason, detail });
  }

  kicked(reason: number): void {
    this.send(CoreKind.Kicked, KickedSchema, { reason });
  }

  regionSet(active: string[], prefetch: string[] = []): void {
    this.send(CoreKind.RegionSet, RegionSetSchema, { active, prefetch });
  }

  spawned(playerId: number, entity: number, regionId = 'cell/1_1'): void {
    this.send(CoreKind.Spawned, SpawnedSchema, { playerId, entity, regionId });
  }

  sessionState(players: { playerId: number; name: string; state: number; entity: number }[]): void {
    this.send(CoreKind.SessionState, SessionStateSchema, { players });
  }

  pong(clientTimeMs: number, serverTimeMs: number, serverTick: number): void {
    this.send(CoreKind.Pong, PongSchema, { clientTimeMs, serverTimeMs, serverTick });
  }

  snapshot(data: SnapshotData): void {
    this.frame([
      {
        kind: CoreKind.Snapshot,
        tick: data.header.serverTick,
        encode: (w) => encodeSnapshot(w, this.registry, data),
      },
    ]);
  }

  events(data: EventsData, tick = 0): void {
    this.frame([
      { kind: CoreKind.Events, tick, encode: (w) => encodeEvents(w, this.registry, data) },
    ]);
  }
}

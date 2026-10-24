import {
  type ByteReader,
  type ByteWriter,
  CoreKind,
  decodeEvents,
  decodeSnapshot,
  decodeSnapshotPart,
  type SnapshotPart,
  type EventsData,
  FrameWriter,
  GAME_MESSAGE_KIND_BASE,
  type KickedPayload,
  KickedSchema,
  type MessageDef,
  type MessageHeader,
  nextSeq,
  type PongPayload,
  PongSchema,
  readFrame,
  type RegionSetPayload,
  RegionSetSchema,
  type RejectedPayload,
  RejectedSchema,
  type Schema,
  type SchemaRegistry,
  type SessionStatePayload,
  SessionStateSchema,
  type SnapshotData,
  type SpawnedPayload,
  SpawnedSchema,
  type WelcomePayload,
  WelcomeSchema,
} from '@conduit/protocol';

/**
 * Outgoing frames for one socket: a `FrameWriter` plus the envelope seq counter (docs/protocol.md
 * 8), which starts at 0 per socket. A message's seq is consumed only when its frame is finished;
 * an aborted frame gives its seqs back.
 */
export class FrameEncoderSession {
  private readonly fw: FrameWriter;
  private next = 0;
  private frameStart = 0;

  constructor(writer: FrameWriter = new FrameWriter()) {
    this.fw = writer;
  }

  /** The seq the next message gets. */
  get seq(): number {
    return this.next;
  }

  /** Discards any open frame and restarts seq at 0 (a new socket). */
  reset(): void {
    this.fw.abort();
    this.next = 0;
    this.frameStart = 0;
  }

  begin(): void {
    this.fw.begin();
    this.frameStart = this.next;
  }

  /** Appends a schema-encoded message; on a throw the message is rolled back and rethrown. */
  add<T>(kind: number, tick: number, schema: Schema<T>, payload: T): void {
    this.addWith(kind, tick, (w) => schema.encode(w, payload));
  }

  addWith(kind: number, tick: number, encode: (w: ByteWriter) => void): void {
    const seq = this.next;
    this.fw.message(kind, tick, seq, encode);
    this.next = nextSeq(seq);
  }

  finish(): Uint8Array {
    return this.fw.finish();
  }

  abort(): void {
    this.fw.abort();
    this.next = this.frameStart;
  }

  /** One message in its own frame. On a throw nothing is consumed. */
  single<T>(kind: number, tick: number, schema: Schema<T>, payload: T): Uint8Array {
    this.begin();
    try {
      this.add(kind, tick, schema, payload);
      return this.finish();
    } catch (err) {
      this.abort();
      throw err;
    }
  }
}

/** Callbacks for the server-to-client messages `dispatchFrame` understands. */
export interface ServerMessageHandlers {
  /** Every message's header, in order, just before its own handler (seq gap counting). */
  header?(h: MessageHeader): void;
  welcome?(p: WelcomePayload, h: MessageHeader): void;
  rejected?(p: RejectedPayload, h: MessageHeader): void;
  sessionState?(p: SessionStatePayload, h: MessageHeader): void;
  spawned?(p: SpawnedPayload, h: MessageHeader): void;
  snapshot?(p: SnapshotData, h: MessageHeader): void;
  snapshotPart?(p: SnapshotPart, h: MessageHeader): void;
  events?(p: EventsData, h: MessageHeader): void;
  pong?(p: PongPayload, h: MessageHeader): void;
  regionSet?(p: RegionSetPayload, h: MessageHeader): void;
  kicked?(p: KickedPayload, h: MessageHeader): void;
  /** A game message whose direction is `s2c` or `both`. */
  message?(def: MessageDef, payload: unknown, h: MessageHeader): void;
  /** A kind the client does not accept: unknown, a client-to-server core kind, or a `c2s` game message. */
  ignored?(h: MessageHeader): void;
}

function decodeWithSchema<T>(
  schema: Schema<T>,
  call: ((p: T, h: MessageHeader) => void) | undefined,
  h: MessageHeader,
  r: ByteReader,
): () => void {
  const p = schema.decode(r);
  return () => call?.(p, h);
}

/**
 * Parses one server frame. Every message is decoded before any handler runs, so a `DecodeError`
 * anywhere (thrown to the caller) discards the whole frame (docs/net.md B.3). Handlers then run in
 * message order; each receives freshly allocated payloads. Returns the number of messages.
 */
export function dispatchFrame(
  buf: Uint8Array,
  registry: SchemaRegistry,
  handlers: ServerMessageHandlers,
): number {
  const calls: (() => void)[] = [];
  const headers: MessageHeader[] = [];
  readFrame(buf, (h, r) => {
    headers.push(h);
    switch (h.kind) {
      case CoreKind.Welcome:
        calls.push(decodeWithSchema(WelcomeSchema, handlers.welcome, h, r));
        return;
      case CoreKind.Rejected:
        calls.push(decodeWithSchema(RejectedSchema, handlers.rejected, h, r));
        return;
      case CoreKind.SessionState:
        calls.push(decodeWithSchema(SessionStateSchema, handlers.sessionState, h, r));
        return;
      case CoreKind.Spawned:
        calls.push(decodeWithSchema(SpawnedSchema, handlers.spawned, h, r));
        return;
      case CoreKind.Pong:
        calls.push(decodeWithSchema(PongSchema, handlers.pong, h, r));
        return;
      case CoreKind.RegionSet:
        calls.push(decodeWithSchema(RegionSetSchema, handlers.regionSet, h, r));
        return;
      case CoreKind.Kicked:
        calls.push(decodeWithSchema(KickedSchema, handlers.kicked, h, r));
        return;
      case CoreKind.Snapshot: {
        const s = decodeSnapshot(r, registry);
        calls.push(() => handlers.snapshot?.(s, h));
        return;
      }
      case CoreKind.SnapshotPart: {
        const part = decodeSnapshotPart(r);
        calls.push(() => handlers.snapshotPart?.(part, h));
        return;
      }
      case CoreKind.Events: {
        const e = decodeEvents(r, registry);
        calls.push(() => handlers.events?.(e, h));
        return;
      }
    }
    const def = h.kind >= GAME_MESSAGE_KIND_BASE ? registry.message(h.kind) : undefined;
    if (def === undefined || def.direction === 'c2s') {
      calls.push(() => handlers.ignored?.(h));
      return;
    }
    const payload = def.schema.decode(r);
    calls.push(() => handlers.message?.(def, payload, h));
  });
  // Phase 2: dispatch. readFrame already validated the framing, so `headers` pairs with `calls`.
  for (let i = 0; i < calls.length; i++) {
    handlers.header?.(headers[i] as MessageHeader);
    (calls[i] as () => void)();
  }
  return calls.length;
}

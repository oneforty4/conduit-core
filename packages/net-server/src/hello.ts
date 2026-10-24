import { isTokenExpired, type SessionToken, type TokenVerifier } from '@conduit/auth';
import {
  CoreKind,
  DEFAULT_SESSION_CAPACITY,
  PROTOCOL_SESSION_CAPACITY_MAX,
  compatibilityDifferences,
  copyCompatibilityDescriptor,
  createCompatibilityDescriptor,
  type CompatibilityDescriptor,
  decodeWith,
  HelloSchema,
  type HelloPayload,
  type MessageHeader,
  readFrame,
  RejectReason,
} from '@conduit/protocol';
import { CloseCode } from './constants.ts';

/**
 * The first message of `frame` when it is a well-formed `Hello`, else `null` (malformed frame, a
 * first message of another kind, an empty frame or an undecodable payload). Used by the gateway to
 * read the token before choosing a worker.
 */
export function peekHello(
  frame: Uint8Array,
): { header: MessageHeader; hello: HelloPayload } | null {
  let result: { header: MessageHeader; hello: HelloPayload } | null = null;
  let first = true;
  try {
    readFrame(frame, (header, payload) => {
      if (!first) return;
      first = false;
      if (header.kind === CoreKind.Hello)
        result = { header, hello: decodeWith(payload, HelloSchema) };
    });
  } catch {
    return null;
  }
  return result;
}

/** Session-side facts `validateHello` checks after the version and schema checks (docs/net.md A.6). */
export interface HelloCheck {
  /** The identity given to `attach`, or the verifier's result; `null` = the token did not verify. */
  identity: SessionToken | null;
  /** `Session.id`; must equal `identity.sessionId`. */
  sessionId: string;
  /** Wall clock, unix ms. */
  nowMs: number;
  /**
   * Whether the identity's token had expired when it was verified. The gateway's verdict when it
   * gave one (`Session.attach`'s `tokenExpired`); default `isTokenExpired(identity, floor(nowMs /
   * 1000))`. An expired identity may only reconnect (`reconnect`); a fresh join is `BadToken`.
   */
  expired?: boolean | undefined;
  /** False while the session is not started or is stopping. */
  running: boolean;
  /** The Hello's `reconnectToken` matched a conn of the same account (the capacity check is skipped). */
  reconnect: boolean;
  /** Conns currently holding a player slot. */
  activePlayers: number;
  maxPlayers: number;
}

/**
 * Why a Hello is rejected, or `null` to accept it, in the order of the A.6 table: a failed token
 * verification, protocol version, registry hash, then (with `check`) the identity's session and
 * expiry (an expired token only reconnects), the session running, and capacity for a fresh join.
 */
export function validateHello(
  hello: HelloPayload,
  game: { readonly protocolVersion: number; readonly compatibility?: CompatibilityDescriptor },
  registry: { readonly hash: number },
  check?: HelloCheck,
): RejectReason | null {
  if (check !== undefined && check.identity === null) return RejectReason.BadToken;
  if (hello.protocolVersion !== game.protocolVersion) return RejectReason.ProtocolVersion;
  if (hello.registryHash !== registry.hash) return RejectReason.SchemaMismatch;
  if (game.compatibility !== undefined) {
    try {
      const offered =
        hello.compatibility === undefined
          ? createCompatibilityDescriptor(game.compatibility.gameId)
          : copyCompatibilityDescriptor(hello.compatibility);
      if (compatibilityDifferences(game.compatibility, offered).length > 0)
        return RejectReason.Compatibility;
    } catch {
      return RejectReason.Compatibility;
    }
  }
  if (check === undefined || check.identity === null) return null;
  const identity = check.identity;
  const expired = check.expired ?? isTokenExpired(identity, Math.floor(check.nowMs / 1000));
  if (identity.sessionId !== check.sessionId || (expired && !check.reconnect)) {
    return RejectReason.BadToken;
  }
  const supported = hello.maxSessionCapacity ?? DEFAULT_SESSION_CAPACITY;
  if (
    !Number.isInteger(supported) ||
    supported < 1 ||
    supported > PROTOCOL_SESSION_CAPACITY_MAX ||
    supported < check.maxPlayers
  )
    return RejectReason.Capacity;
  if (!check.running) return RejectReason.SessionNotRunning;
  if (!check.reconnect && check.activePlayers >= check.maxPlayers) return RejectReason.SessionFull;
  return null;
}

/**
 * The identity for a Hello: the one passed to `attach` (gateway path, authoritative), else
 * `verifier.verify(hello.sessionToken, { displayName }, now)` (createServer path; `null` = bad
 * token). A Hello with a reconnect token is verified with `allowExpired`, so its identity may be
 * expired (`isTokenExpired`); `validateHello` then lets it reconnect only.
 */
export function resolveIdentity(
  hello: HelloPayload,
  identity: SessionToken | null,
  verifier: TokenVerifier | undefined,
  now?: number,
): SessionToken | null {
  if (identity !== null) return identity;
  if (verifier === undefined) return null;
  return verifier.verify(hello.sessionToken, { displayName: hello.displayName }, now, {
    allowExpired: hello.reconnectToken !== '',
  });
}

/** The close code that follows `Rejected{reason}` (docs/net.md A.3). */
export function rejectCloseCode(reason: RejectReason): CloseCode {
  switch (reason) {
    case RejectReason.Capacity:
      return CloseCode.Capacity;
    case RejectReason.Compatibility:
      return CloseCode.Compatibility;
    case RejectReason.SchemaMismatch:
      return CloseCode.SchemaMismatch;
    case RejectReason.BadToken:
      return CloseCode.BadToken;
    case RejectReason.SessionFull:
      return CloseCode.SessionFull;
    case RejectReason.SessionNotRunning:
      return CloseCode.SessionNotRunning;
    case RejectReason.ProtocolVersion:
      return CloseCode.ProtocolVersion;
  }
}

/** The `Rejected.detail` text for `reason`. */
export function rejectDetail(
  reason: RejectReason,
  hello: HelloPayload,
  game: { readonly protocolVersion: number; readonly compatibility?: CompatibilityDescriptor },
): string {
  switch (reason) {
    case RejectReason.Capacity:
      return `session capacity exceeds client limit ${hello.maxSessionCapacity ?? DEFAULT_SESSION_CAPACITY}; update or choose a smaller session`;
    case RejectReason.Compatibility: {
      try {
        if (game.compatibility === undefined) return 'incompatible simulation declaration';
        const offered =
          hello.compatibility ?? createCompatibilityDescriptor(game.compatibility.gameId);
        const text = `update required: ${compatibilityDifferences(game.compatibility, offered).join(', ')}`;
        let detail = '';
        let bytes = 0;
        const encoder = new TextEncoder();
        for (const character of text) {
          const size = encoder.encode(character).length;
          if (bytes + size > 256) break;
          detail += character;
          bytes += size;
        }
        return detail;
      } catch {
        return 'invalid compatibility descriptor';
      }
    }
    case RejectReason.SchemaMismatch:
      return 'please refresh';
    case RejectReason.BadToken:
      return 'bad token';
    case RejectReason.SessionFull:
      return 'session full';
    case RejectReason.SessionNotRunning:
      return 'session not running';
    case RejectReason.ProtocolVersion:
      return `server=${game.protocolVersion} client=${hello.protocolVersion}`;
  }
}

import { QUALIFIED_SESSION_CAPACITY } from '@conduit/protocol';
import { validatePasswordLength } from '@conduit/auth';
import type { CreateSessionRequest, LoginRequest, RegisterRequest, Visibility } from './api.ts';
import { LobbyError } from './errors.ts';

/** Applied after `toLowerCase()`. */
export const USERNAME_RE = /^[a-z0-9_]{3,24}$/;
export const MAX_DISPLAY_NAME_CHARS = 32;
export const MAX_SESSION_NAME_CHARS = 48;
/** Non-archived sessions one account may own. */
export const MAX_SESSIONS_PER_OWNER = 16;

/**
 * A request as it arrives from JSON: every field optional and of unknown type. The typed request
 * interfaces are assignable to it, so the service accepts both.
 */
export type Untrusted<T> = { readonly [K in keyof T]?: unknown };

const MIN_PLAYERS = 1;
const MAX_PLAYERS = QUALIFIED_SESSION_CAPACITY;
const VISIBILITIES: readonly Visibility[] = ['private', 'friends', 'public'];

/**
 * Register input, normalized: `username` lowercased, `displayName` trimmed or defaulted to the
 * username as typed. Throws `LobbyError('validation')` naming the first bad field.
 */
export function validateRegister(input: Untrusted<RegisterRequest>): Required<RegisterRequest> {
  assertObject(input);
  const { username, password, displayName } = input;
  if (typeof username !== 'string' || !USERNAME_RE.test(username.toLowerCase())) {
    throw invalid('username', 'username must be 3..24 characters of a-z, 0-9 and _');
  }
  if (typeof password !== 'string' || !validatePasswordLength(password)) {
    throw invalid('password', 'password must be 8..256 UTF-8 bytes');
  }
  return {
    username: username.toLowerCase(),
    password,
    displayName: displayName === undefined ? username : validateDisplayName(displayName),
  };
}

/**
 * Login input: shape only (two strings), so the response never reveals which rule a password
 * breaks; a password of the wrong length simply fails to verify.
 */
export function validateLogin(input: Untrusted<LoginRequest>): LoginRequest {
  assertObject(input);
  const { username, password } = input;
  if (typeof username !== 'string') throw invalid('username', 'username must be a string');
  if (typeof password !== 'string') throw invalid('password', 'password must be a string');
  return { username, password };
}

/** Create-session input with `name` trimmed; `gameId` must satisfy `games.has`. */
export function validateCreateSession(
  input: Untrusted<CreateSessionRequest>,
  games: { has(gameId: string): boolean },
): CreateSessionRequest {
  assertObject(input);
  const { gameId, name, visibility, maxPlayers } = input;
  if (typeof gameId !== 'string' || !games.has(gameId)) {
    throw invalid('gameId', 'unknown gameId');
  }
  const trimmedName = validateSessionName(name);
  if (!isVisibility(visibility)) {
    throw invalid('visibility', "visibility must be 'private', 'friends' or 'public'");
  }
  if (
    typeof maxPlayers !== 'number' ||
    !Number.isInteger(maxPlayers) ||
    maxPlayers < MIN_PLAYERS ||
    maxPlayers > MAX_PLAYERS
  ) {
    throw invalid('maxPlayers', `maxPlayers must be an integer in ${MIN_PLAYERS}..${MAX_PLAYERS}`);
  }
  return { gameId, name: trimmedName, visibility, maxPlayers };
}

/** A display name, trimmed: 1..32 chars without control characters or lone surrogates. */
export function validateDisplayName(value: unknown): string {
  const name = validText(value, MAX_DISPLAY_NAME_CHARS);
  if (name === null) {
    throw invalid(
      'displayName',
      `displayName must be 1..${MAX_DISPLAY_NAME_CHARS} characters without control characters`,
    );
  }
  return name;
}

/** A session name, trimmed: 1..48 chars without control characters or lone surrogates. */
export function validateSessionName(value: unknown): string {
  const name = validText(value, MAX_SESSION_NAME_CHARS);
  if (name === null) {
    throw invalid(
      'name',
      `name must be 1..${MAX_SESSION_NAME_CHARS} characters without control characters`,
    );
  }
  return name;
}

function validText(value: unknown, maxChars: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text.length < 1 || text.length > maxChars) return null;
  return hasForbiddenChar(text) ? null : text;
}

/** True for a code point below U+0020, U+007F, or a lone surrogate (pairs iterate as one). */
function hasForbiddenChar(text: string): boolean {
  for (const char of text) {
    const cp = char.codePointAt(0) ?? 0;
    if (cp < 0x20 || cp === 0x7f || (cp >= 0xd800 && cp <= 0xdfff)) return true;
  }
  return false;
}

function isVisibility(value: unknown): value is Visibility {
  return VISIBILITIES.some((visibility) => visibility === value);
}

function assertObject(input: unknown): void {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new LobbyError('validation', 'invalid JSON body');
  }
}

function invalid(field: string, message: string): LobbyError {
  return new LobbyError('validation', message, { field });
}

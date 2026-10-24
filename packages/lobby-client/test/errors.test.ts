import type { LobbyErrorCode } from '@conduit/lobby';
import { describe, expect, it } from 'vitest';
import { LobbyError, request } from '../src/index.ts';

/** Every client error code with the status the lobby answers it with (docs/host.md §4). */
const STATUS: Record<LobbyErrorCode | 'network', number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  validation: 400,
  session_full: 409,
  bad_invite: 403,
  rate_limited: 429,
  internal: 500,
  network: 0,
};
const CASES = Object.entries(STATUS) as [LobbyErrorCode | 'network', number][];
const LOBBY_CASES = CASES.filter(
  (entry): entry is [LobbyErrorCode, number] => entry[0] !== 'network',
);

function jsonFetch(status: number, body: unknown): typeof fetch {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
}

describe('LobbyError', () => {
  it.each(CASES)('%s: code, status, message and name', (code, status) => {
    const err = new LobbyError(code, status, `failed with ${code}`);
    expect(err).toBeInstanceOf(LobbyError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('LobbyError');
    expect(err.code).toBe(code);
    expect(err.status).toBe(status);
    expect(err.message).toBe(`failed with ${code}`);
    expect(err.field).toBeUndefined();
    expect('cause' in err).toBe(false);
    expect(String(err)).toBe(`LobbyError: failed with ${code}`);
    expect(err.stack).toContain('failed with');
  });

  it.each(CASES)('%s: keeps field and cause', (code, status) => {
    const cause = new Error('root');
    const err = new LobbyError(code, status, 'bad', { field: 'username', cause });
    expect(err.field).toBe('username');
    expect(err.cause).toBe(cause);
    expect(Object.keys(err)).toContain('field');
  });

  it('keeps instanceof through throw, catch and promise rejection', async () => {
    const thrown = (() => {
      try {
        throw new LobbyError('conflict', 409, 'taken');
      } catch (err) {
        return err;
      }
    })();
    expect(thrown).toBeInstanceOf(LobbyError);
    await expect(Promise.reject(thrown)).rejects.toBeInstanceOf(LobbyError);
    await expect(Promise.reject(thrown)).rejects.toMatchObject({ code: 'conflict', status: 409 });
  });

  it.each(LOBBY_CASES)(
    '%s: an ErrorResponse body rejects request() with that code and the HTTP status',
    async (code, status) => {
      const body = { error: code, message: `the lobby said ${code}`, field: 'name' };
      const fetch = jsonFetch(status, body);
      const err: unknown = await request({ fetch, url: 'http://l/x' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LobbyError);
      expect(err).toMatchObject({ code, status, message: `the lobby said ${code}`, field: 'name' });
    },
  );

  it('network: a rejected fetch rejects request() with status 0 and the cause', async () => {
    const cause = new TypeError('fetch failed');
    const failing: typeof fetch = () => Promise.reject(cause);
    const err: unknown = await request({ fetch: failing, url: 'http://l/x' }).catch((e) => e);
    expect(err).toBeInstanceOf(LobbyError);
    expect(err).toMatchObject({ code: 'network', status: 0, cause });
    expect((err as LobbyError).field).toBeUndefined();
  });
});

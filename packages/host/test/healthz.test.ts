import { afterEach, describe, expect, it } from 'vitest';
import type { HealthResponse } from '../src/health.ts';
import { healthRoute } from '../src/health.ts';
import type { SessionHealth } from '../src/session-manager.ts';
import {
  createSession,
  joinSession,
  lobbyLogin,
  startHost,
  type TestHost,
  waitFor,
} from './fixtures/helpers.ts';

const hosts: TestHost[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
});

async function healthz(target: TestHost): Promise<HealthResponse> {
  const res = await fetch(`${target.url}/healthz`);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toMatch(/^application\/json/);
  return (await res.json()) as HealthResponse;
}

describe('GET /healthz', () => {
  it('answers without auth with no sessions, then one running session and its tick stats', async () => {
    const before = Date.now();
    const target = await startHost();
    hosts.push(target);
    const empty = await healthz(target);
    expect(empty).toEqual({
      ok: true,
      startedAt: expect.any(Number),
      uptimeS: expect.any(Number),
      sessions: { running: 0, starting: 0, stopping: 0, faulted: 0 },
      list: [],
    });
    expect(empty.startedAt).toBeGreaterThanOrEqual(before - 1000);
    expect(empty.uptimeS).toBeGreaterThanOrEqual(0);

    const { cookie } = await lobbyLogin(target, 'alice');
    const { id } = await createSession(target, cookie);
    await joinSession(target, cookie, id);
    const one = await healthz(target);
    expect(one.sessions).toEqual({ running: 1, starting: 0, stopping: 0, faulted: 0 });
    expect(one.list).toEqual([
      {
        sessionId: id,
        gameId: 'host-fixture',
        state: 'running',
        status: 'live',
        statsAgeMs: null,
        clients: 0,
        startedAt: expect.any(Number),
        tick: null,
      },
    ]);

    await waitFor(() => target.host.sessions.health()[0]?.tick !== null, 'tickStats', 5000);
    const ticked = await healthz(target);
    expect(ticked.list[0]?.tick).toMatchObject({
      tick: expect.any(Number),
      players: 0,
      entities: expect.any(Number),
      regionsActive: expect.any(Number),
      dropped: expect.any(Number),
      perClient: [],
      counters: expect.any(Object),
    });
    expect(ticked.list[0]?.tick?.tick).toBeGreaterThan(0);
    // The worker's wake-lateness histogram (docs/net.md A.5) reaches /healthz.
    const late = ticked.list[0]?.tick?.wakeLateness;
    expect(late?.wakes).toBeGreaterThan(0);
    expect(late?.histogram.reduce((sum, n) => sum + n, 0)).toBe(late?.wakes);
  });

  it('counts sessions by state and reports uptime from startedAt', async () => {
    const list = [
      { sessionId: 'a', gameId: 'g', state: 'running', clients: 2, startedAt: 1, tick: null },
      { sessionId: 'b', gameId: 'g', state: 'starting', clients: 0, startedAt: 2, tick: null },
      { sessionId: 'c', gameId: 'g', state: 'running', clients: 0, startedAt: 3, tick: null },
      { sessionId: 'd', gameId: 'g', state: 'stopping', clients: 1, startedAt: 4, tick: null },
    ] satisfies SessionHealth[];
    const app = healthRoute({ health: () => list }, 10_000, () => 72_500);
    const res = await app.request('/healthz');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({
      ok: true,
      startedAt: 10_000,
      uptimeS: 62,
      sessions: { running: 2, starting: 1, stopping: 1, faulted: 0 },
      list,
    });
  });
});

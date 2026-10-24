import { Hono } from 'hono';
import type { SessionHealth, WorkerState } from './session-manager.ts';

export interface HealthResponse {
  ok: true;
  /** Unix ms. */
  startedAt: number;
  uptimeS: number;
  sessions: Record<WorkerState, number>;
  list: SessionHealth[];
}

/**
 * `GET /healthz` (docs/host.md 22): `200 { ok, startedAt, uptimeS, sessions: { running, starting,
 * stopping }, list }`, without auth. A Hono app to mount before the lobby routes.
 */
export function healthRoute(
  sessions: { health(): SessionHealth[] },
  startedAt: number,
  now: () => number = Date.now,
): Hono {
  const app = new Hono();
  app.get('/healthz', (c) => {
    const list = sessions.health();
    const counts: Record<WorkerState, number> = {
      running: 0,
      starting: 0,
      stopping: 0,
      faulted: 0,
    };
    for (const entry of list) counts[entry.state]++;
    const body: HealthResponse = {
      ok: true,
      startedAt,
      uptimeS: Math.max(0, Math.floor((now() - startedAt) / 1000)),
      sessions: counts,
      list,
    };
    c.header('Cache-Control', 'no-store');
    return c.json(body);
  });
  return app;
}

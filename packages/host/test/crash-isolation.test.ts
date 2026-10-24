import { openApplicationSave } from '@conduit/persist';
import { afterEach, describe, expect, it } from 'vitest';
import { GATEWAY_CLOSE } from '../src/constants.ts';
import {
  createSession,
  joinAndConnect,
  lobbyFetch,
  lobbyLogin,
  startHost,
  type TestHost,
  waitFor,
} from './fixtures/helpers.ts';

const hosts: TestHost[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
});

async function saves(target: TestHost, sessionId: string): Promise<number | null> {
  const save = await openApplicationSave(target.host.store, { scope: sessionId });
  const blob = await save.get('session', 'state');
  return blob === null
    ? null
    : (JSON.parse(new TextDecoder().decode(blob)) as { saves: number }).saves;
}

describe('crash isolation', () => {
  it('a crashing worker closes its sockets with 4110; the host lives on and the session resumes from its save', async () => {
    // The fixture saves, then throws outside the Session, at the first tick >= 30 with both players in.
    const target = await startHost({ workerExtra: { crashAtTick: 30, crashWithPlayers: 2 } });
    hosts.push(target);
    const alice = await lobbyLogin(target, 'alice');
    const bob = await lobbyLogin(target, 'bob');
    const { id } = await createSession(target, alice.cookie, 'public');

    const a = await joinAndConnect(target, alice.cookie, id, 'alice');
    const b = await joinAndConnect(target, bob.cookie, id, 'bob');
    await Promise.all([a.next('Welcome'), b.next('Welcome')]);
    const [closedA, closedB] = await Promise.all([a.closed, b.closed]);
    expect(closedA).toEqual({ code: GATEWAY_CLOSE.WORKER_CRASHED, reason: 'worker crashed' });
    expect(closedB).toEqual({ code: GATEWAY_CLOSE.WORKER_CRASHED, reason: 'worker crashed' });
    await waitFor(() => !target.host.sessions.has(id), 'the crash handled');
    expect(target.logger.messages('error').some((m) => m.includes('worker crashed'))).toBe(true);

    // The HTTP side is unaffected, and the lobby marked the session idle.
    expect((await fetch(`${target.url}/healthz`)).status).toBe(200);
    expect((await lobbyFetch(target, alice.cookie, '/me')).status).toBe(200);
    const summary = await lobbyFetch(target, alice.cookie, `/sessions/${id}`);
    expect(summary.status).toBe(200);
    expect(await summary.json()).toMatchObject({ id, state: 'idle' });
    expect(await saves(target, id)).toBe(1); // what the worker saved before it crashed

    // The next join starts a new worker, which loads that state and keeps running.
    const again = await lobbyFetch(target, bob.cookie, `/sessions/${id}/join`, {
      method: 'POST',
      body: {},
    });
    expect(again.status).toBe(200);
    expect(target.host.sessions.isRunning(id)).toBe(true);
    const back = await joinAndConnect(target, alice.cookie, id, 'alice');
    const back2 = await joinAndConnect(target, bob.cookie, id, 'bob');
    await Promise.all([back.next('Welcome'), back2.next('Welcome')]);
    await target.host.sessions.flushAll();
    expect(await saves(target, id)).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 700)); // past tick 30 with both players in
    expect(target.host.sessions.isRunning(id)).toBe(true);
    expect(back.closeInfo).toBeNull();
    expect((await lobbyFetch(target, alice.cookie, `/sessions/${id}`)).status).toBe(200);
  });
});

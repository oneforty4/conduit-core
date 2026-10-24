import { PlayerState } from '@conduit/protocol';
import { defineSystem } from '@conduit/sim';
import { expect, it, vi } from 'vitest';
import { createHarness, joinAndSpawn } from './harness.ts';

it('releases held input and expires the player after a committed frame send fails', async () => {
  const inputs: unknown[] = [];
  const h = await createHarness({
    snapshotEvery: 1,
    session: { reconnectGraceMs: 100 },
    systems: [
      defineSystem('observe-input', 'sim', (ctx) => {
        inputs.push(ctx.inputs(0));
      }),
    ],
  });
  const client = h.client();
  await joinAndSpawn(h, client);
  client.input([h.session.tick + 1], 127);
  vi.spyOn(client.link, 'send').mockImplementationOnce(() => {
    throw new Error('transport failed');
  });
  await h.step();
  expect(h.session.fault).toBeNull();
  expect(h.session.players()[0]?.state).toBe(PlayerState.Away);
  await h.step();
  expect(inputs.at(-1)).toBeUndefined();
  await h.step(8);
  expect(h.session.players()).toEqual([]);
  expect(client.link.closedWith).not.toBeNull();
  await h.session.stop();
});

it('isolates simultaneous send failures during Away broadcasts without faulting healthy players', async () => {
  const h = await createHarness({ snapshotEvery: 1 });
  const a = h.client(),
    b = h.client(),
    healthy = h.client();
  await joinAndSpawn(h, a);
  await joinAndSpawn(h, b);
  await joinAndSpawn(h, healthy);
  for (const client of [a, b])
    vi.spyOn(client.link, 'send').mockImplementation(() => {
      throw new Error('closed');
    });
  healthy.take();
  await h.step();
  expect(h.session.fault).toBeNull();
  expect(h.session.players().map((player) => player.state)).toEqual([
    PlayerState.Away,
    PlayerState.Away,
    PlayerState.Playing,
  ]);
  expect(healthy.take().some((message) => message.name === 'Snapshot')).toBe(true);
  vi.restoreAllMocks();
  await h.session.stop();
});

it('does not transition a closed connection to Loading when Ready delivery fails outside a tick', async () => {
  const h = await createHarness();
  const client = h.client();
  client.hello();
  await h.step(); // The join hook has run, so Ready sends RegionSet synchronously.
  vi.spyOn(client.link, 'send').mockImplementationOnce(() => {
    throw new Error('RegionSet failed');
  });
  expect(() => client.ready()).not.toThrow();
  await h.step();
  expect(h.session.fault).toBeNull();
  expect(h.session.players()).toEqual([]);
  await h.session.stop();
});

it('does not run the join hook after Welcome delivery fails outside a tick', async () => {
  const joined = vi.fn();
  const h = await createHarness({
    hooks: {
      onPlayerJoin: () => {
        joined();
        throw new Error('must not join');
      },
    },
  });
  const client = h.client();
  vi.spyOn(client.link, 'send').mockImplementationOnce(() => {
    throw new Error('Welcome failed');
  });
  expect(() => client.hello()).not.toThrow();
  await h.step();
  expect(joined).not.toHaveBeenCalled();
  expect(h.session.players()).toEqual([]);
  expect(h.session.fault).toBeNull();
  await h.session.stop();
});

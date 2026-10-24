/// <reference lib="dom" />
import { openApplicationSave } from '@conduit/persist';
import { KickReason } from '@conduit/protocol';
import { defineSystem, type InputLog, Transform } from '@conduit/sim';
import { describe, expect, it, vi } from 'vitest';
import { SESSION_STATE_KEY, SESSION_STATE_NAMESPACE } from '../src/session.ts';
import { createHarness, joinAndSpawn, Shout, Weather } from './harness.ts';

describe('strict authoritative faults', () => {
  it('quarantines events, sends and recording, preserves prior save, and reports once', async () => {
    let fail = false;
    const report = vi.fn();
    const log: InputLog = { version: 1, seed: 0xc0ffee, tickRate: 60, entries: [] };
    const h = await createHarness({
      snapshotEvery: 1,
      session: { onFault: report, recordLog: log },
      hooks: { onSave: (ctx) => new Uint8Array([ctx.world.tick]) },
      systems: [
        defineSystem('explode', 'sim', (ctx) => {
          if (!fail) return;
          const entity = [...ctx.world.query(Transform)][0]!;
          ctx.world.write(entity, Transform).pos.x = 123;
          ctx.events.emit(Weather, { kind: 'partial' });
          ctx.world.destroy(entity);
          throw new Error('broken');
        }),
      ],
    });
    const client = h.client();
    await joinAndSpawn(h, client);
    await h.session.flushAll();
    const before = await (
      await openApplicationSave(h.store)
    ).get(SESSION_STATE_NAMESPACE, SESSION_STATE_KEY);
    const entries = log.entries.slice();
    client.take();
    fail = true;
    await h.step();
    expect(client.take()).toEqual([]);
    expect(client.link.closedWith).toMatchObject({ code: 4012, reason: 'session faulted' });
    expect(h.session.fault).toMatchObject({ system: 'explode', phase: 'sim' });
    expect(log.entries).toEqual(entries);
    await expect(h.session.flushAll()).rejects.toThrow('broken');
    await Promise.all([h.session.stop(), h.session.stop()]);
    expect(
      await (await openApplicationSave(h.store)).get(SESSION_STATE_NAMESPACE, SESSION_STATE_KEY),
    ).toEqual(before);
    expect(report).toHaveBeenCalledTimes(1);
    expect(h.session.running).toBe(false);
  });

  it('quarantines a hook kick and closes terminally only after the hook faults', async () => {
    const h = await createHarness({
      hooks: {
        onMessage: (_player, _def, _payload, ctx) => {
          ctx.session.kick(0, KickReason.ByHost);
          throw new Error('failed after kick');
        },
      },
    });
    const client = h.client();
    await joinAndSpawn(h, client);
    client.take();
    client.sendMessage(Shout, { text: 'trigger' });
    await h.step();
    expect(client.take()).toEqual([]);
    expect(client.link.closedWith).toMatchObject({ code: 4012 });
    expect(h.session.fault).toMatchObject({ system: 'onMessage' });
    await h.session.stop();
  });

  it('finishes a detached valid image waiting for storage while refusing postfault captures', async () => {
    let fail = false;
    const h = await createHarness({
      hooks: { onSave: (ctx) => new Uint8Array([ctx.world.tick]) },
      systems: [
        defineSystem('fail-later', 'sim', () => {
          if (fail) throw new Error('late fault');
        }),
      ],
    });
    const client = h.client();
    await joinAndSpawn(h, client);
    await h.session.flushAll();
    await h.step();
    const validTick = h.session.tick;
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let reached!: () => void;
    const capturing = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const transaction = h.store.transaction.bind(h.store);
    vi.spyOn(h.store, 'transaction').mockImplementation(async (fn) => {
      reached();
      await gate;
      return transaction(fn);
    });
    const saving = h.session.flushAll();
    await capturing;
    fail = true;
    await h.step();
    await expect(h.session.flushAll()).rejects.toThrow('late fault');
    resume();
    await saving;
    await h.session.stop();
    expect(
      await (await openApplicationSave(h.store)).get(SESSION_STATE_NAMESPACE, SESSION_STATE_KEY),
    ).toEqual(new Uint8Array([validTick]));
  });

  it('allows a valid image already writing to finish across a fault and shutdown', async () => {
    let fail = false;
    const h = await createHarness({
      hooks: { onSave: (ctx) => new Uint8Array([ctx.world.tick]) },
      systems: [
        defineSystem('fail-after-capture', 'sim', () => {
          if (fail) throw new Error('writing fault');
        }),
      ],
    });
    await h.step();
    let resume!: () => void;
    let captured!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const writing = new Promise<void>((resolve) => {
      captured = resolve;
    });
    const transaction = h.store.transaction.bind(h.store);
    const put = vi.fn();
    vi.spyOn(h.store, 'transaction').mockImplementation((fn) =>
      transaction((tx) =>
        fn({
          ...tx,
          async put(namespace, key, bytes) {
            put(namespace, key);
            if (namespace === 'save_data') {
              captured();
              await gate;
            }
            return tx.put(namespace, key, bytes);
          },
        }),
      ),
    );
    const validTick = h.session.tick;
    const saving = h.session.flushAll();
    await writing;
    fail = true;
    await h.step();
    const stopping = h.session.stop();
    resume();
    await saving;
    await stopping;
    expect(
      await (await openApplicationSave(h.store)).get(SESSION_STATE_NAMESPACE, SESSION_STATE_KEY),
    ).toEqual(new Uint8Array([validTick]));
    expect(put.mock.calls.filter(([namespace]) => namespace === 'save_data')).toHaveLength(1);
  });

  it('keeps an independent session responsive after a tail failure', async () => {
    const bad = await createHarness();
    const healthy = await createHarness();
    bad.session.simulation.tail.push(() => {
      throw new Error('tail failed');
    });
    await bad.step();
    await healthy.step(3);
    expect(bad.session.fault).toMatchObject({ phase: 'tail' });
    expect(healthy.session.running).toBe(true);
    expect(healthy.session.tick).toBe(3);
    await Promise.all([bad.session.stop(), healthy.session.stop()]);
  });
});

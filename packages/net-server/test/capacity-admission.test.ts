import { RejectReason } from '@conduit/protocol';
import { describe, expect, it } from 'vitest';
import { CloseCode } from '../src/constants.ts';
import { createHarness, joinAndSpawn, payloadOf } from './harness.ts';

describe('explicit session capacity admission', () => {
  it('rejects a smaller client limit before spawn and keeps capacity pinned through reconnect', async () => {
    const h = await createHarness({ session: { maxPlayers: 2 } });
    const small = h.client();
    small.hello({ maxSessionCapacity: 1 });
    expect(payloadOf(small.take(), 'Rejected')).toMatchObject({ reason: RejectReason.Capacity });
    expect(small.link.closedWith?.code).toBe(CloseCode.Capacity);
    expect(h.hooks.onPlayerJoin).not.toHaveBeenCalled();
    const first = h.client();
    const joined = await joinAndSpawn(h, first, 'first', { maxSessionCapacity: 2 });
    const welcome = payloadOf<{
      playerId: number;
      reconnectToken: string;
      sessionCapacity: number;
    }>(joined, 'Welcome');
    expect(welcome.sessionCapacity).toBe(2);
    const second = h.client();
    await joinAndSpawn(h, second, 'second', { maxSessionCapacity: 2 });
    const full = h.client();
    full.hello({ maxSessionCapacity: 16 });
    expect(payloadOf(full.take(), 'Rejected')).toMatchObject({ reason: RejectReason.SessionFull });
    first.link.remoteClose();
    const badResume = h.client();
    badResume.hello({
      displayName: 'first',
      reconnectToken: welcome.reconnectToken,
      maxSessionCapacity: 1,
    });
    expect(payloadOf(badResume.take(), 'Rejected')).toMatchObject({
      reason: RejectReason.Capacity,
    });
    const resume = h.client();
    resume.hello({
      displayName: 'first',
      reconnectToken: welcome.reconnectToken,
      maxSessionCapacity: 2,
    });
    expect(payloadOf(resume.take(), 'Welcome')).toMatchObject({
      playerId: welcome.playerId,
      sessionCapacity: 2,
    });
    expect(h.hooks.onPlayerJoin).toHaveBeenCalledTimes(2);
    await h.session.stop();
  });
  it('keeps larger public capacities gated before qualification', async () => {
    await expect(createHarness({ session: { maxPlayers: 9 } })).rejects.toThrow('maxPlayers');
  });
});

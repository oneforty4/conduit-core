import { CoreKind, defineInput, defineMessage, f, FrameWriter } from '@conduit/protocol';
import { describe, expect, it } from 'vitest';
import { createHarness, joinAndSpawn } from './harness.ts';

const FloatInput = defineInput({ tick: f.u32, value: f.f32 });
describe('finite network admission', () => {
  for (const value of [NaN, Infinity, -Infinity])
    it(`rejects ${String(value)} input before gameplay without faulting the session`, async () => {
      const h = await createHarness({ input: FloatInput });
      const client = h.client();
      await joinAndSpawn(h, client);
      client.take();
      const before = h.session.tick;
      const writer = new FrameWriter();
      writer.begin();
      // docs/protocol.md 9.7: firstTick | count 1 | the frame's fields after its tick
      writer.message(CoreKind.Input, 0, client.seq++, (bytes) => {
        bytes.u32(before + 1);
        bytes.u8(1);
        bytes.f32(value);
      });
      client.link.receive(writer.finish());
      expect(h.session.stats.badFrames).toBe(1);
      expect(h.session.fault).toBeNull();
      await h.step();
      expect(h.session.tick).toBe(before + 1);
      expect(h.session.fault).toBeNull();
      await h.session.stop();
    });
});

const FloatMessage = defineMessage('FloatMessage', 'c2s', { value: f.f32 });
for (const value of [NaN, Infinity, -Infinity])
  it(`rejects ${String(value)} game-message values before user callbacks`, async () => {
    let calls = 0;
    const h = await createHarness({
      messages: [FloatMessage],
      hooks: {
        onMessage: () => {
          calls++;
        },
      },
    });
    const client = h.client();
    await joinAndSpawn(h, client);
    client.take();
    const writer = new FrameWriter();
    writer.begin();
    writer.message(h.game.registry.messageKind(FloatMessage), 0, client.seq++, (bytes) =>
      bytes.f32(value),
    );
    client.link.receive(writer.finish());
    await h.step();
    expect(calls).toBe(0);
    expect(h.session.stats.badFrames).toBe(1);
    expect(h.session.fault).toBeNull();
    await h.session.stop();
  });

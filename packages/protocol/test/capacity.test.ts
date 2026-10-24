import { expect, it } from 'vitest';
import {
  ByteReader,
  ByteWriter,
  DEFAULT_SESSION_CAPACITY,
  QUALIFIED_SESSION_CAPACITY,
  PROTOCOL_SESSION_CAPACITY_MAX,
  SessionStateSchema,
  encodeWith,
  decodeWith,
} from '../src/index.ts';
it('separates default, qualified capacity and hard wire ceiling', () => {
  expect(DEFAULT_SESSION_CAPACITY).toBe(8);
  expect(QUALIFIED_SESSION_CAPACITY).toBe(8);
  expect(PROTOCOL_SESSION_CAPACITY_MAX).toBe(16);
});
it('encodes complete membership up to the wire ceiling without advertising larger session support', () => {
  const players = Array.from({ length: 16 }, (_, playerId) => ({
    playerId,
    name: `player-${playerId}`,
    state: 0,
    entity: 0,
  }));
  const bytes = new ByteWriter();
  encodeWith(bytes, SessionStateSchema, { players });
  expect(decodeWith(new ByteReader(bytes.view()), SessionStateSchema).players).toEqual(players);
  expect(() =>
    encodeWith(new ByteWriter(), SessionStateSchema, { players: [...players, players[0]!] }),
  ).toThrow();
});

import { Rng } from '../../packages/math/src/index.ts';
import { encodeExactState } from '../../packages/sim/src/index.ts';
const rng = new Rng(12345);
const values = Array.from({ length: 100 }, () => rng.next());
const encoded = encodeExactState({
  signedZero: -0,
  optional: undefined,
  raw: 1 / 3,
  values,
  rng: rng.state(),
  bytes: new Uint8Array([0, 1, 255]),
});
globalThis.exactRuntimeContract = {
  state: rng.state(),
  values,
  exactHex: Array.from(encoded, (byte) => byte.toString(16).padStart(2, '0')).join(''),
};

import { randomBytes } from 'node:crypto';
import { RECONNECT_TOKEN_BYTES } from './constants.ts';

/** `base64url(randomBytes(RECONNECT_TOKEN_BYTES))`: 32 URL-safe characters (docs/net.md A.6). */
export function newReconnectToken(): string {
  return randomBytes(RECONNECT_TOKEN_BYTES).toString('base64url');
}

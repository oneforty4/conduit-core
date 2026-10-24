import { defineMessage, f } from '@conduit/game';

/** The longest `Chat.text`, in UTF-8 bytes (`f.str` counts bytes, docs/protocol.md 4). */
export const CHAT_MAX_BYTES = 200;

/**
 * Chat in both directions (PLAN.md "Sandbox content spec"): a client sends the text its player
 * typed; the server's `onMessage.Chat` broadcasts `'<displayName>: <text>'` to every player.
 */
export const Chat = defineMessage('Chat', 'both', { text: f.str(CHAT_MAX_BYTES) });

export type ChatMessage = ReturnType<typeof Chat.schema.create>;

/**
 * The session's join counter, server to client (M4): `onPlayerJoin` broadcasts the new `total` to
 * every player, and the HUD shows it in `#hud-joins`. The counter is what `onSave` stores, so after a
 * restart on the same database it continues instead of starting over.
 */
export const Joins = defineMessage('Joins', 's2c', { total: f.u32 });

export type JoinsMessage = ReturnType<typeof Joins.schema.create>;

/**
 * `text` cut to at most `maxBytes` UTF-8 bytes without splitting a code point. A lone surrogate
 * counts 3 bytes, as `TextEncoder` writes it as U+FFFD.
 */
export function clipUtf8(text: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    const size = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += ch.length;
  }
  return end === text.length ? text : text.slice(0, end);
}

/** What the server broadcasts for `displayName`'s chat `text`: `'<displayName>: <text>'`, clipped. */
export function chatLine(displayName: string, text: string): string {
  return clipUtf8(`${displayName}: ${text}`, CHAT_MAX_BYTES);
}

import { CHAT_MAX_BYTES, clipUtf8, type ChatMessage } from '../shared/messages.ts';
import { isTextEntry } from './input.ts';

/** The chat's DOM ids (PLAN.md "Sandbox content spec"). */
export const CHAT_IDS = { log: 'chat-log', input: 'chat-input' } as const;

/** Lines `#chat-log` keeps; older ones are removed. */
export const CHAT_LOG_LINES = 50;

function required(doc: Document, id: string): HTMLElement {
  const el = doc.getElementById(id);
  if (el === null) throw new Error(`sandbox chat: #${id} is missing from index.html`);
  return el;
}

/**
 * The chat box: `#chat-input` sends on Enter (trimmed, clipped to `Chat.text`'s 200 UTF-8 bytes,
 * blank lines ignored) and Escape leaves it; Enter anywhere else on the page focuses it. Lines the
 * server broadcasts go to `#chat-log` as text (never HTML), newest last.
 */
export class ChatBox {
  private readonly log: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly send: (msg: ChatMessage) => void;
  private readonly doc: Document;

  /** `send` is called with each message to send (the client's `send(Chat, msg)`). */
  constructor(doc: Document, send: (msg: ChatMessage) => void) {
    this.doc = doc;
    this.log = required(doc, CHAT_IDS.log);
    const input = required(doc, CHAT_IDS.input);
    if (!(input instanceof HTMLInputElement)) {
      throw new Error(`sandbox chat: #${CHAT_IDS.input} must be an <input>`);
    }
    this.input = input;
    this.send = send;
    this.input.addEventListener('keydown', this.onInputKey);
    doc.addEventListener('keydown', this.onPageKey);
  }

  /** `CreateClientOpts.onMessage.Chat`: appends the broadcast line. */
  append(msg: unknown): void {
    const text = (msg as Partial<ChatMessage> | null)?.text;
    if (typeof text !== 'string') return;
    const line = this.doc.createElement('li');
    line.textContent = text;
    this.log.append(line);
    while (this.log.childElementCount > CHAT_LOG_LINES) this.log.firstElementChild?.remove();
    this.log.scrollTop = this.log.scrollHeight;
  }

  dispose(): void {
    this.input.removeEventListener('keydown', this.onInputKey);
    this.doc.removeEventListener('keydown', this.onPageKey);
  }

  private readonly onInputKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      this.input.blur();
      return;
    }
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    const text = clipUtf8(this.input.value.trim(), CHAT_MAX_BYTES);
    this.input.value = '';
    if (text !== '') this.send({ text });
  };

  private readonly onPageKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' || isTextEntry(event.target)) return;
    event.preventDefault();
    this.input.focus();
  };
}

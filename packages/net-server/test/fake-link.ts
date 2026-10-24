import { QueuedLinkBase } from '../src/link.ts';

/**
 * An in-memory `ClientLink` for Session tests. `receive` delivers a client frame, `remoteClose`
 * simulates the peer closing, `buffered` scripts `bufferedAmount()`. A local `close()` records the
 * code and reports the close from a microtask, like a real transport.
 */
export class FakeLink extends QueuedLinkBase {
  readonly sent: Uint8Array[] = [];
  buffered = 0;
  closedWith: { code: number; reason: string } | null = null;
  bytesSent = 0;

  send(buf: Uint8Array): void {
    if (this.closed) return;
    this.sent.push(buf);
    this.bytesSent += buf.byteLength;
  }

  bufferedAmount(): number {
    return this.buffered;
  }

  receive(buf: Uint8Array): void {
    this.deliver(buf);
  }

  remoteClose(code = 1006, reason = ''): void {
    this.handleClosed(code, reason);
  }

  /** Removes and returns everything sent so far. */
  take(): Uint8Array[] {
    return this.sent.splice(0);
  }

  protected closeTransport(code: number, reason: string): void {
    this.closedWith = { code, reason };
    queueMicrotask(() => this.handleClosed(code, reason));
  }
}

// Test helper (not a test file): a TCP relay in front of a game server whose connections can be cut
// abruptly, so both WebSocket ends see an abnormal close (1006) as on a real network failure.
import { connect, createServer, type Server, type Socket } from 'node:net';

export interface ProxyTarget {
  /** Default `127.0.0.1`. */
  host?: string;
  port: number;
}

export class TcpProxy {
  private readonly server: Server;
  private readonly target: ProxyTarget;
  /** Both sides of every relayed connection still open. */
  private readonly sockets = new Set<Socket>();
  private refusing = false;
  private boundPort = 0;

  private constructor(target: ProxyTarget) {
    this.target = target;
    this.server = createServer((client) => this.relay(client));
  }

  /** Listens on an ephemeral port of 127.0.0.1 and relays each connection to `target`. */
  static async start(target: ProxyTarget): Promise<TcpProxy> {
    const proxy = new TcpProxy(target);
    await new Promise<void>((resolve, reject) => {
      proxy.server.once('error', reject);
      proxy.server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = proxy.server.address();
    if (address === null || typeof address !== 'object') throw new Error('TcpProxy: no port');
    proxy.boundPort = address.port;
    return proxy;
  }

  get port(): number {
    return this.boundPort;
  }

  /** `ws://127.0.0.1:<port>`. */
  get url(): string {
    return `ws://127.0.0.1:${this.boundPort}`;
  }

  /**
   * Destroys every relayed connection at once, without a close handshake. While `refuse` is true
   * (the default) new connections are destroyed on arrival until `restore()`.
   */
  cut(refuse = true): void {
    this.refusing = refuse;
    for (const socket of [...this.sockets]) socket.destroy();
  }

  /** Relays new connections again. */
  restore(): void {
    this.refusing = false;
  }

  async close(): Promise<void> {
    this.cut();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private relay(client: Socket): void {
    if (this.refusing) {
      client.destroy();
      return;
    }
    const upstream = connect({ host: this.target.host ?? '127.0.0.1', port: this.target.port });
    const pairs: [Socket, Socket][] = [
      [client, upstream],
      [upstream, client],
    ];
    for (const [from, to] of pairs) {
      this.sockets.add(from);
      from.pipe(to);
      from.on('error', () => to.destroy());
      from.on('close', () => {
        this.sockets.delete(from);
        to.destroy();
      });
    }
  }
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
}

export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

const RANK: Readonly<Record<LogLevel, number>> = { debug: 0, info: 1, warn: 2, error: 3 };

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && Object.hasOwn(RANK, value);
}

/** Whether a message at `level` passes a logger configured with `threshold`. */
export function logs(threshold: LogLevel, level: LogLevel): boolean {
  return RANK[level] >= RANK[threshold];
}

/** `data` as plain, structured-cloneable JSON-like values (errors keep name, message, stack, code). */
export function plainData(data: unknown, depth = 0): unknown {
  if (data instanceof Error) {
    const out: Record<string, unknown> = { name: data.name, message: data.message };
    if (data.stack !== undefined) out.stack = data.stack;
    const code = (data as { code?: unknown }).code;
    if (code !== undefined) out.code = plainData(code, depth + 1);
    if (data.cause !== undefined && depth < 4) out.cause = plainData(data.cause, depth + 1);
    return out;
  }
  if (typeof data === 'bigint') return data.toString();
  if (typeof data === 'function' || typeof data === 'symbol') return String(data);
  if (data === null || typeof data !== 'object') return data;
  if (depth >= 6) return '[object]';
  if (Array.isArray(data)) return data.map((item) => plainData(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) out[key] = plainData(value, depth + 1);
  return out;
}

function formatData(data: unknown): string {
  if (data === undefined) return '';
  try {
    return ` ${JSON.stringify(plainData(data))}`;
  } catch {
    return ` ${String(data)}`;
  }
}

/**
 * Prints `ISO-time level msg JSON(data)` lines for messages at `level` and above: debug and info to
 * stdout, warn and error to stderr.
 */
export function consoleLogger(level: LogLevel = 'info'): Logger {
  const write = (at: LogLevel, msg: string, data?: unknown): void => {
    if (!logs(level, at)) return;
    const line = `${new Date().toISOString()} ${at} ${msg}${formatData(data)}\n`;
    const stream = at === 'warn' || at === 'error' ? process.stderr : process.stdout;
    stream.write(line);
  };
  return {
    debug: (msg, data) => write('debug', msg, data),
    info: (msg, data) => write('info', msg, data),
    warn: (msg, data) => write('warn', msg, data),
    error: (msg, data) => write('error', msg, data),
  };
}

/**
 * A worker's logger (docs/host.md 18, 21): posts `{ t: 'log', level, msg, data }` for messages at
 * `level` and above; the main thread prefixes `[session <id>]` and logs them. `data` is posted as
 * plain values (`plainData`), so errors and odd values survive the structured clone.
 */
export function portLogger(port: { postMessage(msg: unknown): void }, level: LogLevel): Logger {
  const post = (at: LogLevel, msg: string, data?: unknown): void => {
    if (!logs(level, at)) return;
    const message: { t: 'log'; level: LogLevel; msg: string; data?: unknown } = {
      t: 'log',
      level: at,
      msg,
    };
    if (data !== undefined) message.data = plainData(data);
    try {
      port.postMessage(message);
    } catch {
      port.postMessage({ t: 'log', level: at, msg, data: formatData(data).trim() });
    }
  };
  return {
    debug: (msg, data) => post('debug', msg, data),
    info: (msg, data) => post('info', msg, data),
    warn: (msg, data) => post('warn', msg, data),
    error: (msg, data) => post('error', msg, data),
  };
}

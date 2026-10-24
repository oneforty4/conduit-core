import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertSecret } from '@conduit/auth';
import { DEFAULT_DB_PATH, DEFAULT_PORT, IDLE_TIMEOUT_MS } from './constants.ts';
import { isLogLevel, LOG_LEVELS, type LogLevel } from './logger.ts';

/** The host's settings (docs/host.md 16). */
export interface HostConfig {
  /** 0..65535; 0 picks a free port. */
  port: number;
  /** HMAC secret for session tokens, at least 32 UTF-8 bytes. */
  secret: string;
  /** SQLite file; `':memory:'` allowed. */
  dbPath: string;
  /** An existing directory served at `/` (absolute once loaded). */
  staticDir?: string;
  /** `ws://` or `wss://` origin used in join responses, without a trailing slash. */
  publicWsBase?: string;
  /** >= 1000. */
  idleTimeoutMs: number;
  trustProxy: boolean;
  logLevel: LogLevel;
}

/** `loadConfig` overrides (CLI flags, `HostOptions`); `undefined` values count as absent. */
export type HostConfigOverrides = { [K in keyof HostConfig]?: HostConfig[K] | undefined };

/** An invalid or missing setting; `variable` names the environment variable it belongs to. */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
  readonly variable: string;

  constructor(variable: string, message: string) {
    super(message);
    this.variable = variable;
  }
}

const INTEGER_RE = /^\d+$/;
const WS_BASE_RE = /^wss?:\/\/[^/]/;

function integer(variable: string, raw: string | number, min: number, max: number): number {
  const value = typeof raw === 'number' ? raw : INTEGER_RE.test(raw.trim()) ? Number(raw) : NaN;
  if (!Number.isInteger(value) || value < min || value > max) {
    const range = max === Number.MAX_SAFE_INTEGER ? `>= ${min}` : `in ${min}..${max}`;
    throw new ConfigError(variable, `${variable} must be an integer ${range}, got ${String(raw)}`);
  }
  return value;
}

function boolean(variable: string, raw: string | boolean): boolean {
  if (typeof raw === 'boolean') return raw;
  const value = raw.trim().toLowerCase();
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false' || value === '') return false;
  throw new ConfigError(variable, `${variable} must be '1', 'true', '0' or 'false', got ${raw}`);
}

/** The first of `override` and `env[variable]` that is set (an empty variable counts as unset). */
function pick<T>(
  override: T | undefined,
  env: NodeJS.ProcessEnv,
  variable: string,
): T | string | undefined {
  if (override !== undefined) return override;
  const raw = env[variable];
  return raw === undefined || raw === '' ? undefined : raw;
}

/**
 * Reads the host settings from `env` (default `process.env`) with `overrides` (CLI flags,
 * `HostOptions`) winning, and validates every one (docs/host.md 16). Throws `ConfigError` naming
 * the variable of the first invalid or missing setting.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: HostConfigOverrides = {},
): HostConfig {
  const rawPort = pick(overrides.port, env, 'PORT');
  const port = rawPort === undefined ? DEFAULT_PORT : integer('PORT', rawPort, 0, 65535);

  const secret = pick(overrides.secret, env, 'HOST_SECRET');
  if (typeof secret !== 'string') {
    throw new ConfigError('HOST_SECRET', 'HOST_SECRET is required (at least 32 UTF-8 bytes)');
  }
  try {
    assertSecret(secret);
  } catch {
    throw new ConfigError('HOST_SECRET', 'HOST_SECRET must be at least 32 UTF-8 bytes');
  }

  const dbPath = pick(overrides.dbPath, env, 'DB_PATH') ?? DEFAULT_DB_PATH;

  const rawIdle = pick(overrides.idleTimeoutMs, env, 'IDLE_TIMEOUT_MS');
  const idleTimeoutMs =
    rawIdle === undefined
      ? IDLE_TIMEOUT_MS
      : integer('IDLE_TIMEOUT_MS', rawIdle, 1000, Number.MAX_SAFE_INTEGER);

  const rawTrust = pick(overrides.trustProxy, env, 'TRUST_PROXY');
  const trustProxy = rawTrust === undefined ? false : boolean('TRUST_PROXY', rawTrust);

  const rawLevel = pick(overrides.logLevel, env, 'LOG_LEVEL') ?? 'info';
  if (!isLogLevel(rawLevel)) {
    throw new ConfigError(
      'LOG_LEVEL',
      `LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}, got ${rawLevel}`,
    );
  }

  const config: HostConfig = {
    port,
    secret,
    dbPath,
    idleTimeoutMs,
    trustProxy,
    logLevel: rawLevel,
  };

  const staticDir = pick(overrides.staticDir, env, 'STATIC_DIR');
  if (staticDir !== undefined) {
    const dir = resolve(staticDir);
    let isDirectory = false;
    try {
      isDirectory = statSync(dir).isDirectory();
    } catch {
      isDirectory = false;
    }
    if (!isDirectory) {
      throw new ConfigError(
        'STATIC_DIR',
        `STATIC_DIR must be an existing directory, got ${staticDir}`,
      );
    }
    config.staticDir = dir;
  }

  const publicWsBase = pick(overrides.publicWsBase, env, 'PUBLIC_WS_BASE');
  if (publicWsBase !== undefined) {
    if (!WS_BASE_RE.test(publicWsBase) || publicWsBase.endsWith('/')) {
      throw new ConfigError(
        'PUBLIC_WS_BASE',
        `PUBLIC_WS_BASE must start with ws:// or wss:// and have no trailing slash, got ${publicWsBase}`,
      );
    }
    config.publicWsBase = publicWsBase;
  }
  return config;
}

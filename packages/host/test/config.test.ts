import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.ts';
import { IDLE_TIMEOUT_MS } from '../src/constants.ts';

const SECRET = 's'.repeat(32);
const dir = mkdtempSync(join(tmpdir(), 'conduit-host-config-'));
const file = join(dir, 'not-a-dir.txt');
writeFileSync(file, 'x');

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function errorOf(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (err) {
    if (err instanceof ConfigError) return err;
    throw err;
  }
  throw new Error('expected a ConfigError');
}

describe('loadConfig', () => {
  it('has the documented defaults', () => {
    expect(loadConfig({ HOST_SECRET: SECRET })).toEqual({
      port: 8080,
      secret: SECRET,
      dbPath: './conduit.sqlite',
      idleTimeoutMs: IDLE_TIMEOUT_MS,
      trustProxy: false,
      logLevel: 'info',
    });
  });

  it('parses every variable', () => {
    expect(
      loadConfig({
        PORT: '0',
        HOST_SECRET: SECRET,
        DB_PATH: ':memory:',
        STATIC_DIR: dir,
        PUBLIC_WS_BASE: 'wss://play.example.com',
        IDLE_TIMEOUT_MS: '1000',
        TRUST_PROXY: 'true',
        LOG_LEVEL: 'debug',
      }),
    ).toEqual({
      port: 0,
      secret: SECRET,
      dbPath: ':memory:',
      staticDir: dir,
      publicWsBase: 'wss://play.example.com',
      idleTimeoutMs: 1000,
      trustProxy: true,
      logLevel: 'debug',
    });
    expect(loadConfig({ HOST_SECRET: SECRET, TRUST_PROXY: '1', PORT: '65535' })).toMatchObject({
      trustProxy: true,
      port: 65535,
    });
    expect(loadConfig({ HOST_SECRET: SECRET, TRUST_PROXY: 'false' }).trustProxy).toBe(false);
    expect(
      loadConfig({ HOST_SECRET: SECRET, PUBLIC_WS_BASE: 'ws://localhost:8080' }).publicWsBase,
    ).toBe('ws://localhost:8080');
    expect(loadConfig({ HOST_SECRET: SECRET, STATIC_DIR: '.' }).staticDir).toBe(process.cwd());
  });

  it('requires HOST_SECRET of at least 32 bytes', () => {
    for (const env of [{}, { HOST_SECRET: '' }, { HOST_SECRET: 's'.repeat(31) }]) {
      const err = errorOf(() => loadConfig(env));
      expect(err.variable).toBe('HOST_SECRET');
      expect(err.message).toContain('HOST_SECRET');
    }
    expect(errorOf(() => loadConfig({}, { secret: '\u{E9}'.repeat(15) })).variable).toBe(
      'HOST_SECRET',
    );
    expect(loadConfig({ HOST_SECRET: '\u{E9}'.repeat(16) }).secret).toBe('\u{E9}'.repeat(16));
  });

  it('rejects bad values, naming the variable', () => {
    const cases: [Record<string, string>, string][] = [
      [{ PORT: '65536' }, 'PORT'],
      [{ PORT: '-1' }, 'PORT'],
      [{ PORT: '80.5' }, 'PORT'],
      [{ PORT: 'http' }, 'PORT'],
      [{ STATIC_DIR: file }, 'STATIC_DIR'],
      [{ STATIC_DIR: join(dir, 'missing') }, 'STATIC_DIR'],
      [{ PUBLIC_WS_BASE: 'http://example.com' }, 'PUBLIC_WS_BASE'],
      [{ PUBLIC_WS_BASE: 'wss://example.com/' }, 'PUBLIC_WS_BASE'],
      [{ PUBLIC_WS_BASE: 'wss://' }, 'PUBLIC_WS_BASE'],
      [{ IDLE_TIMEOUT_MS: '999' }, 'IDLE_TIMEOUT_MS'],
      [{ IDLE_TIMEOUT_MS: 'soon' }, 'IDLE_TIMEOUT_MS'],
      [{ TRUST_PROXY: 'yes' }, 'TRUST_PROXY'],
      [{ LOG_LEVEL: 'verbose' }, 'LOG_LEVEL'],
    ];
    for (const [env, variable] of cases) {
      const err = errorOf(() => loadConfig({ HOST_SECRET: SECRET, ...env }));
      expect(err.variable, JSON.stringify(env)).toBe(variable);
      expect(err.message).toContain(variable);
    }
  });

  it('lets overrides win over env, validates them, and ignores undefined overrides', () => {
    const env = {
      HOST_SECRET: SECRET,
      PORT: '9000',
      DB_PATH: 'env.sqlite',
      LOG_LEVEL: 'warn',
      IDLE_TIMEOUT_MS: '5000',
    };
    expect(
      loadConfig(env, {
        port: 0,
        secret: 't'.repeat(40),
        dbPath: ':memory:',
        logLevel: 'error',
        idleTimeoutMs: undefined,
        staticDir: dir,
        trustProxy: true,
      }),
    ).toEqual({
      port: 0,
      secret: 't'.repeat(40),
      dbPath: ':memory:',
      staticDir: dir,
      idleTimeoutMs: 5000,
      trustProxy: true,
      logLevel: 'error',
    });
    expect(errorOf(() => loadConfig(env, { port: 70000 })).variable).toBe('PORT');
    expect(errorOf(() => loadConfig(env, { idleTimeoutMs: 10 })).variable).toBe('IDLE_TIMEOUT_MS');
  });

  it('reads process.env by default', () => {
    const saved = process.env.HOST_SECRET;
    process.env.HOST_SECRET = 'e'.repeat(33);
    try {
      expect(loadConfig().secret).toBe('e'.repeat(33));
    } finally {
      if (saved === undefined) delete process.env.HOST_SECRET;
      else process.env.HOST_SECRET = saved;
    }
  });
});

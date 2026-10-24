import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ASSET_ID_RE,
  GROUP_NAME_RE,
  MANIFEST_JSON_SCHEMA,
  ManifestValidationError,
  SRI_RE,
  assertValidManifest,
  base64Encode,
  depsOf,
  resolveUrl,
  sha256Sri,
  sriFromDigest,
  validateManifest,
  type AssetEntry,
  type Manifest,
  type ManifestErrorCode,
} from '../src/index.ts';

const HASH = `sha256-${'A'.repeat(43)}=` as const;

function asset(url: string, extra: Partial<AssetEntry> = {}): AssetEntry {
  return { type: 'binary', url, hash: HASH, size: 1, ...extra };
}

/** A valid manifest; tests break one thing at a time. */
function valid(): Manifest {
  return {
    version: 1,
    baseUrl: '/assets/',
    assets: {
      'ship.sloop': asset('ship/sloop.0123abcd.glb', {
        type: 'model',
        size: 5860,
        deps: ['textures.sloop'],
      }),
      'textures.sloop': asset('textures/sloop.89abcdef.png', { type: 'texture' }),
      'sfx.horn': asset('sfx/horn.00000000.ogg', { type: 'audio', size: 0 }),
      'ui.theme': asset('ui/theme.11111111.json', { type: 'json' }),
    },
    groups: { core: ['sfx.horn', 'ui.theme'], ships: ['ship.sloop'] },
    regions: { 'cell/0_0': ['ship.sloop', 'sfx.horn'], 'cell/0_1': [] },
  };
}

/** `valid()` with `mutate` applied to a deep copy; returns it as untyped input. */
function broken(mutate: (m: Manifest) => void): unknown {
  const copy = JSON.parse(JSON.stringify(valid())) as Manifest;
  mutate(copy);
  return copy;
}

/** Writes a value the types forbid, to build invalid manifests. */
function put(target: object, key: string, value: unknown): void {
  Reflect.set(target, key, value);
}

function entry(m: Manifest, id: string): AssetEntry {
  const found = m.assets[id];
  if (found === undefined) throw new Error(`fixture has no asset ${id}`);
  return found;
}

const codes = (input: unknown): ManifestErrorCode[] => validateManifest(input).map((e) => e.code);

describe('validateManifest', () => {
  it('accepts a valid manifest, including after a JSON round trip', () => {
    expect(validateManifest(valid())).toEqual([]);
    expect(validateManifest(JSON.parse(JSON.stringify(valid())))).toEqual([]);
    expect(() => assertValidManifest(valid())).not.toThrow();
  });

  it('bad_version is the only error and stops validation', () => {
    const input = broken((m) => {
      put(m, 'version', 2);
      m.baseUrl = 'nope';
      put(m, 'assets', 5);
    });
    expect(validateManifest(input)).toEqual([
      { code: 'bad_version', path: 'version', message: 'version must be 1, got 2' },
    ]);
    for (const notAManifest of [null, [], 'manifest', 1]) {
      expect(codes(notAManifest)).toEqual(['bad_version']);
    }
  });

  it('bad_base_url when baseUrl is not a string ending in /', () => {
    expect(codes(broken((m) => (m.baseUrl = '/assets')))).toEqual(['bad_base_url']);
    expect(codes(broken((m) => put(m, 'baseUrl', 42)))).toEqual(['bad_base_url']);
    expect(codes(broken((m) => (m.baseUrl = 'https://cdn.example.com/game/')))).toEqual([]);
  });

  it('bad_id for ids outside the grammar or longer than 128 characters', () => {
    const cases = [
      'Ship.sloop',
      'ship..sloop',
      '.ship',
      'ship.',
      '_ship',
      'ship_hull',
      'ship-hull',
    ];
    for (const id of cases) {
      const errors = validateManifest(broken((m) => (m.assets[id] = asset(`x/${id}.bin`))));
      expect(errors, id).toEqual([
        expect.objectContaining({ code: 'bad_id', path: `assets.${id}` }),
      ]);
    }
    const long = `a.${'b'.repeat(126)}`;
    expect(long).toHaveLength(128);
    expect(codes(broken((m) => (m.assets[long] = asset('long.bin'))))).toEqual([]);
    expect(codes(broken((m) => (m.assets[`${long}c`] = asset('longer.bin'))))).toEqual(['bad_id']);
    // Ids that shadow Object.prototype members are ordinary ids.
    expect(codes(broken((m) => put(m.assets, 'constructor', asset('c.bin'))))).toEqual([]);
  });

  it('bad_type, bad_hash and bad_size per entry field', () => {
    expect(validateManifest(broken((m) => put(entry(m, 'sfx.horn'), 'type', 'sound')))).toEqual([
      expect.objectContaining({ code: 'bad_type', path: 'assets.sfx.horn.type' }),
    ]);
    for (const hash of [
      'sha256-abc=',
      `sha512-${'A'.repeat(43)}=`,
      `sha256-${'A'.repeat(44)}`,
      7,
    ]) {
      expect(codes(broken((m) => put(entry(m, 'sfx.horn'), 'hash', hash))), String(hash)).toEqual([
        'bad_hash',
      ]);
    }
    for (const size of [-1, 1.5, '12', null]) {
      expect(codes(broken((m) => put(entry(m, 'sfx.horn'), 'size', size))), String(size)).toEqual([
        'bad_size',
      ]);
    }
  });

  it('bad_url for empty, absolute, backslash and .. urls', () => {
    for (const url of [
      '',
      '/sfx/horn.ogg',
      'sfx\\horn.ogg',
      '../horn.ogg',
      'sfx/../horn.ogg',
      '..',
      3,
    ]) {
      expect(
        validateManifest(broken((m) => put(entry(m, 'sfx.horn'), 'url', url))),
        String(url),
      ).toEqual([expect.objectContaining({ code: 'bad_url', path: 'assets.sfx.horn.url' })]);
    }
    for (const url of ['horn.ogg', 'sfx/..horn.ogg', 'sfx/horn..ogg', 'a/b/c.d.ogg']) {
      expect(codes(broken((m) => put(entry(m, 'sfx.horn'), 'url', url))), url).toEqual([]);
    }
  });

  it('bad_shape for structure the JSON Schema rejects', () => {
    expect(validateManifest(broken((m) => put(m, 'extra', true)))).toEqual([
      expect.objectContaining({ code: 'bad_shape', path: 'extra' }),
    ]);
    expect(
      validateManifest(broken((m) => put(entry(m, 'sfx.horn'), 'src', 'sfx/horn.ogg'))),
    ).toEqual([expect.objectContaining({ code: 'bad_shape', path: 'assets.sfx.horn.src' })]);
    expect(
      validateManifest(
        broken((m) => {
          put(m.assets, 'sfx.horn', 'sfx/horn.ogg');
          put(entry(m, 'ui.theme'), 'deps', 'sfx.horn');
          put(m.groups, 'core', 'sfx.horn');
          put(m.regions, 'cell/0_0', [7]);
        }),
      ).map((e) => `${e.code} ${e.path}`),
    ).toEqual([
      'bad_shape assets.sfx.horn',
      'bad_shape assets.ui.theme.deps',
      'bad_shape groups.core',
      'bad_shape regions.cell/0_0[0]',
      // 'sfx.horn' is still a key of assets, so references to it are not unknown.
    ]);
    expect(codes(broken((m) => Reflect.deleteProperty(m, 'groups')))).toEqual(['bad_shape']);
    expect(codes(broken((m) => put(m, 'assets', [])))).toEqual([
      'bad_shape',
      'unknown_group_asset',
      'unknown_group_asset',
      'unknown_group_asset',
      'unknown_region_asset',
      'unknown_region_asset',
    ]);
  });

  it('duplicate_url on the second occurrence only', () => {
    const input = broken((m) => (entry(m, 'ui.theme').url = entry(m, 'sfx.horn').url));
    expect(validateManifest(input)).toEqual([
      {
        code: 'duplicate_url',
        path: 'assets.ui.theme.url',
        message: "url 'sfx/horn.00000000.ogg' is already used by sfx.horn",
      },
    ]);
  });

  it('unknown_dep, self_dep and duplicate_list_entry in deps', () => {
    const input = broken(
      (m) =>
        (entry(m, 'ship.sloop').deps = ['textures.sloop', 'nope', 'ship.sloop', 'textures.sloop']),
    );
    expect(validateManifest(input).map((e) => `${e.code} ${e.path}`)).toEqual([
      'unknown_dep assets.ship.sloop.deps[1]',
      'self_dep assets.ship.sloop.deps[2]',
      'duplicate_list_entry assets.ship.sloop.deps[3]',
    ]);
  });

  it('dep_cycle: a 3-cycle is reported once with the full path', () => {
    const input = broken((m) => {
      m.assets = {
        a: asset('a.bin', { deps: ['b'] }),
        b: asset('b.bin', { deps: ['c'] }),
        c: asset('c.bin', { deps: ['a'] }),
      };
      m.groups = {};
      m.regions = {};
    });
    expect(validateManifest(input)).toEqual([
      { code: 'dep_cycle', path: 'assets.a', message: 'a -> b -> c -> a' },
    ]);
  });

  it('dep_cycle: each distinct cycle once, found from the first asset in insertion order', () => {
    const input = broken((m) => {
      m.assets = {
        x: asset('x.bin'),
        b: asset('b.bin', { deps: ['c', 'x'] }),
        c: asset('c.bin', { deps: ['b', 'd'] }),
        d: asset('d.bin', { deps: ['b'] }),
      };
      m.groups = {};
      m.regions = {};
    });
    expect(validateManifest(input).map((e) => `${e.path}: ${e.message}`)).toEqual([
      'assets.b: b -> c -> b',
      'assets.b: b -> c -> d -> b',
    ]);
  });

  it('bad_group_name, unknown_group_asset, unknown_region_asset, duplicate_list_entry in lists', () => {
    const input = broken((m) => {
      m.groups = { Core: ['sfx.horn'], ships: ['ship.sloop', 'ship.brig', 'ship.sloop'] };
      m.regions = { 'cell/9_9': ['sfx.horn', 'sfx.horn', 'sfx.foghorn'] };
    });
    expect(validateManifest(input).map((e) => `${e.code} ${e.path}`)).toEqual([
      'bad_group_name groups.Core',
      'unknown_group_asset groups.ships[1]',
      'duplicate_list_entry groups.ships[2]',
      'duplicate_list_entry regions.cell/9_9[1]',
      'unknown_region_asset regions.cell/9_9[2]',
    ]);
  });

  it('collects every error in rule order instead of stopping at the first', () => {
    const input = broken((m) => {
      m.baseUrl = 'assets';
      m.assets['Bad.id'] = asset('bad.bin');
      put(entry(m, 'Bad.id'), 'hash', 'nope');
      entry(m, 'ui.theme').url = entry(m, 'sfx.horn').url;
      entry(m, 'sfx.horn').deps = ['ghost'];
      m.groups.core?.push('ghost');
      m.regions['cell/0_1'] = ['ghost'];
    });
    expect(codes(input)).toEqual([
      'bad_base_url',
      'bad_id',
      'bad_hash',
      'duplicate_url',
      'unknown_dep',
      'unknown_group_asset',
      'unknown_region_asset',
    ]);
  });

  it('ManifestValidationError carries the errors and one line per error', () => {
    const input = broken((m) => {
      m.baseUrl = 'x';
      m.groups.core = ['ghost'];
    });
    let thrown: unknown;
    try {
      assertValidManifest(input);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ManifestValidationError);
    const error = thrown as ManifestValidationError;
    expect(error.errors).toEqual(validateManifest(input));
    expect(error.message).toBe(
      'bad_base_url baseUrl: baseUrl must be a string ending in \'/\', got "x"\n' +
        "unknown_group_asset groups.core[0]: 'ghost' is not an asset",
    );
  });
});

describe('MANIFEST_JSON_SCHEMA', () => {
  const { properties } = MANIFEST_JSON_SCHEMA;
  const entrySchema = properties.assets.additionalProperties.properties;

  it('uses the same patterns as the validator constants', () => {
    expect(properties.assets.propertyNames.pattern).toBe(ASSET_ID_RE.source);
    expect(properties.groups.propertyNames.pattern).toBe(GROUP_NAME_RE.source);
    expect(entrySchema.hash.pattern).toBe(SRI_RE.source);
    expect(entrySchema.deps.items.pattern).toBe(ASSET_ID_RE.source);
    expect(entrySchema.type.enum).toEqual(['model', 'texture', 'audio', 'json', 'binary']);
  });

  it('url pattern rejects exactly the urls validateManifest rejects', () => {
    const urlRe = new RegExp(entrySchema.url.pattern);
    const urls = [
      '',
      '/a.bin',
      'a\\b.bin',
      '..',
      '../a.bin',
      'a/../b.bin',
      'a/..',
      'a.bin',
      'a/b..c.bin',
      '..a/b.bin',
    ];
    for (const url of urls) {
      const accepted = codes(broken((m) => put(entry(m, 'sfx.horn'), 'url', url))).length === 0;
      expect(urlRe.test(url), url).toBe(accepted);
    }
  });
});

describe('manifest helpers', () => {
  it('resolveUrl joins baseUrl and url and rejects unknown ids', () => {
    expect(resolveUrl(valid(), 'ship.sloop')).toBe('/assets/ship/sloop.0123abcd.glb');
    expect(() => resolveUrl(valid(), 'nope')).toThrow(new RangeError('unknown asset nope'));
    expect(() => resolveUrl(valid(), 'constructor')).toThrow(RangeError);
  });

  it('depsOf returns deps before dependants without duplicates on a diamond', () => {
    const m = valid();
    m.assets = {
      a: asset('a.bin', { deps: ['b', 'c'] }),
      b: asset('b.bin', { deps: ['d'] }),
      c: asset('c.bin', { deps: ['d', 'e'] }),
      d: asset('d.bin'),
      e: asset('e.bin', { deps: ['d'] }),
    };
    expect(depsOf(m, 'a')).toEqual(['d', 'b', 'e', 'c']);
    expect(depsOf(m, 'c')).toEqual(['d', 'e']);
    expect(depsOf(m, 'd')).toEqual([]);
    expect(() => depsOf(m, 'nope')).toThrow(RangeError);
  });
});

describe('hash helpers', () => {
  it('base64Encode matches the standard encoding for every padding case', () => {
    const bytes = Uint8Array.from({ length: 64 }, (_, i) => (i * 37 + 11) % 256);
    for (let n = 0; n <= 7; n++) {
      const slice = bytes.subarray(0, n);
      expect(base64Encode(slice)).toBe(Buffer.from(slice).toString('base64'));
    }
    expect(base64Encode(bytes)).toBe(Buffer.from(bytes).toString('base64'));
  });

  it('sriFromDigest formats a 32-byte digest and rejects other lengths', () => {
    const digest = createHash('sha256').update('abc').digest();
    expect(sriFromDigest(digest)).toBe('sha256-ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=');
    expect(SRI_RE.test(sriFromDigest(digest))).toBe(true);
    expect(() => sriFromDigest(new Uint8Array(31))).toThrow(RangeError);
  });

  it('sha256Sri hashes ArrayBuffers and Uint8Array views with crypto.subtle', async () => {
    expect(await sha256Sri(new Uint8Array(0))).toBe(
      'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=',
    );
    const abc = new TextEncoder().encode('xabcx').subarray(1, 4);
    expect(await sha256Sri(abc)).toBe('sha256-ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=');
    expect(await sha256Sri(new TextEncoder().encode('abc').buffer)).toBe(
      'sha256-ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=',
    );
  });
});

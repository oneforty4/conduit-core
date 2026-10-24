/**
 * Manifest format (docs/assets.md §1.1, §1.2): types, grammar constants, the JSON Schema, and the
 * lookup helpers shared by `AssetLoader` and the build tooling. Isomorphic.
 */

/** Logical asset id: `ASSET_ID_RE`, at most `ASSET_ID_MAX_LENGTH` characters. */
export type AssetId = string;
/** Region id (docs/world.md); its grammar is not validated here. */
export type RegionId = string;
export type AssetType = 'model' | 'texture' | 'audio' | 'json' | 'binary';
/** `'sha256-'` + standard padded base64 of the 32-byte digest (subresource-integrity form). */
export type Sha256Sri = `sha256-${string}`;

export interface AssetEntry {
  type: AssetType;
  /** Relative to `Manifest.baseUrl`; POSIX separators; no leading `/`; no `..` segments. */
  url: string;
  hash: Sha256Sri;
  /** Byte length, integer >= 0. */
  size: number;
  /** Acquired transitively before this asset resolves. */
  deps?: AssetId[];
}

export interface Manifest {
  version: 1;
  /** Ends with `/`; absolute URL or root-relative path. */
  baseUrl: string;
  assets: Record<AssetId, AssetEntry>;
  /** Group names match `GROUP_NAME_RE`. */
  groups: Record<string, AssetId[]>;
  regions: Record<RegionId, AssetId[]>;
}

export const MANIFEST_VERSION = 1;
export const ASSET_ID_RE = /^[a-z0-9]+(\.[a-z0-9_]+)*$/;
export const ASSET_ID_MAX_LENGTH = 128;
export const GROUP_NAME_RE = /^[a-z0-9_]+$/;
export const SRI_RE = /^sha256-[A-Za-z0-9+/]{43}=$/;
export const ASSET_TYPES: readonly AssetType[] = ['model', 'texture', 'audio', 'json', 'binary'];

/** Draft 2020-12 schema for editors and external tooling; `validateManifest` applies the same rules. */
export const MANIFEST_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://conduit.dev/schemas/manifest-1.json',
  type: 'object',
  required: ['version', 'baseUrl', 'assets', 'groups', 'regions'],
  additionalProperties: false,
  properties: {
    version: { const: 1 },
    baseUrl: { type: 'string', pattern: '/$' },
    assets: {
      type: 'object',
      propertyNames: { pattern: '^[a-z0-9]+(\\.[a-z0-9_]+)*$', maxLength: 128 },
      additionalProperties: {
        type: 'object',
        required: ['type', 'url', 'hash', 'size'],
        additionalProperties: false,
        properties: {
          type: { enum: ['model', 'texture', 'audio', 'json', 'binary'] },
          url: {
            type: 'string',
            minLength: 1,
            pattern: '^(?!/)(?!.*\\\\)(?!.*(^|/)\\.\\.(/|$)).+$',
          },
          hash: { type: 'string', pattern: '^sha256-[A-Za-z0-9+/]{43}=$' },
          size: { type: 'integer', minimum: 0 },
          deps: {
            type: 'array',
            items: { type: 'string', pattern: '^[a-z0-9]+(\\.[a-z0-9_]+)*$' },
            uniqueItems: true,
          },
        },
      },
    },
    groups: {
      type: 'object',
      propertyNames: { pattern: '^[a-z0-9_]+$' },
      additionalProperties: { type: 'array', items: { type: 'string' }, uniqueItems: true },
    },
    regions: {
      type: 'object',
      additionalProperties: { type: 'array', items: { type: 'string' }, uniqueItems: true },
    },
  },
} as const;

/** The entry for `id` when it is an own key of `manifest.assets` (ids like `constructor` are legal). */
function entryOf(manifest: Manifest, id: AssetId): AssetEntry | undefined {
  return Object.hasOwn(manifest.assets, id) ? manifest.assets[id] : undefined;
}

/** `baseUrl + entry.url`. Throws `RangeError` for an id that is not in the manifest. */
export function resolveUrl(manifest: Manifest, id: AssetId): string {
  const entry = entryOf(manifest, id);
  if (entry === undefined) throw new RangeError(`unknown asset ${id}`);
  return manifest.baseUrl + entry.url;
}

/**
 * Transitive dependencies of `id`, deps before dependants, without duplicates and without `id`
 * itself (post-order DFS). Unknown dep ids are included, so acquiring them fails loudly. Throws
 * `RangeError` for an unknown `id`.
 */
export function depsOf(manifest: Manifest, id: AssetId): AssetId[] {
  if (entryOf(manifest, id) === undefined) throw new RangeError(`unknown asset ${id}`);
  const out: AssetId[] = [];
  const seen = new Set<AssetId>([id]);
  const visit = (x: AssetId): void => {
    for (const d of entryOf(manifest, x)?.deps ?? []) {
      if (seen.has(d)) continue;
      seen.add(d);
      visit(d);
      out.push(d);
    }
  };
  visit(id);
  return out;
}

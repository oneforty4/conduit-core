import {
  ASSET_ID_MAX_LENGTH,
  ASSET_ID_RE,
  ASSET_TYPES,
  GROUP_NAME_RE,
  MANIFEST_VERSION,
  SRI_RE,
  type AssetId,
  type Manifest,
} from './manifest.ts';

export type ManifestErrorCode =
  | 'bad_version'
  | 'bad_base_url'
  | 'bad_shape'
  | 'bad_id'
  | 'bad_type'
  | 'bad_url'
  | 'bad_hash'
  | 'bad_size'
  | 'duplicate_url'
  | 'unknown_dep'
  | 'self_dep'
  | 'dep_cycle'
  | 'bad_group_name'
  | 'unknown_group_asset'
  | 'unknown_region_asset'
  | 'duplicate_list_entry';

export interface ManifestError {
  code: ManifestErrorCode;
  /** JSON-pointer-ish location, e.g. `assets.ship.sloop.deps[1]` or `regions.r_3_4[0]`. */
  path: string;
  /** Human text; for `dep_cycle` the cycle itself, e.g. `a -> b -> c -> a`. */
  message: string;
}

export class ManifestValidationError extends Error {
  override readonly name = 'ManifestValidationError';
  readonly errors: ManifestError[];

  constructor(errors: ManifestError[]) {
    super(errors.map((e) => `${e.code} ${e.path}: ${e.message}`).join('\n'));
    this.errors = errors;
  }
}

const TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  'version',
  'baseUrl',
  'assets',
  'groups',
  'regions',
]);
const ENTRY_KEYS: ReadonlySet<string> = new Set(['type', 'url', 'hash', 'size', 'deps']);

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function show(value: unknown): string {
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function urlProblem(url: unknown): string | null {
  if (typeof url !== 'string' || url.length === 0) return 'url must be a non-empty string';
  if (url.startsWith('/')) return `url '${url}' must be relative (no leading '/')`;
  if (url.includes('\\')) return `url '${url}' must use '/' separators`;
  if (url.split('/').includes('..')) return `url '${url}' must not contain '..' segments`;
  return null;
}

/** Rotation of a cycle that starts at its smallest id, so each cycle has one key. */
function cycleKey(cycle: readonly AssetId[]): string {
  let start = 0;
  cycle.forEach((id, i) => {
    if (id < (cycle[start] ?? id)) start = i;
  });
  return [...cycle.slice(start), ...cycle.slice(0, start)].join('\n');
}

/**
 * Validates `input` against docs/assets.md §1.3 and returns every error found (`[]` when valid).
 * Rules run in the documented order and never stop early, except a wrong `version`, which is the
 * only error reported. Structural problems the JSON Schema rejects (non-object sections, unknown
 * properties, non-array lists, non-string list members) are `bad_shape`. Pure.
 */
export function validateManifest(input: unknown): ManifestError[] {
  if (!isRecord(input) || input.version !== MANIFEST_VERSION) {
    const got = isRecord(input) ? show(input.version) : show(input);
    return [{ code: 'bad_version', path: 'version', message: `version must be 1, got ${got}` }];
  }
  const errors: ManifestError[] = [];
  const push = (code: ManifestErrorCode, path: string, message: string): void => {
    errors.push({ code, path, message });
  };

  // 2. baseUrl, then the top-level shape.
  if (typeof input.baseUrl !== 'string' || !input.baseUrl.endsWith('/')) {
    push(
      'bad_base_url',
      'baseUrl',
      `baseUrl must be a string ending in '/', got ${show(input.baseUrl)}`,
    );
  }
  for (const key of Object.keys(input)) {
    if (!TOP_LEVEL_KEYS.has(key)) push('bad_shape', key, `unknown top-level property '${key}'`);
  }
  let assets: Json = {};
  if (isRecord(input.assets)) assets = input.assets;
  else push('bad_shape', 'assets', 'assets must be an object keyed by asset id');
  const ids = new Set<AssetId>(Object.keys(assets));

  // 3. Per-asset fields, in insertion order.
  const entries: [AssetId, Json][] = [];
  for (const [id, raw] of Object.entries(assets)) {
    const at = `assets.${id}`;
    if (!ASSET_ID_RE.test(id) || id.length > ASSET_ID_MAX_LENGTH) {
      push(
        'bad_id',
        at,
        `asset id '${id}' must match ${String(ASSET_ID_RE)} and be at most ${ASSET_ID_MAX_LENGTH} characters`,
      );
    }
    if (!isRecord(raw)) {
      push('bad_shape', at, 'asset entry must be an object');
      continue;
    }
    entries.push([id, raw]);
    if (!(ASSET_TYPES as readonly unknown[]).includes(raw.type)) {
      push(
        'bad_type',
        `${at}.type`,
        `type must be one of ${ASSET_TYPES.join(', ')}, got ${show(raw.type)}`,
      );
    }
    const urlError = urlProblem(raw.url);
    if (urlError !== null) push('bad_url', `${at}.url`, urlError);
    if (typeof raw.hash !== 'string' || !SRI_RE.test(raw.hash)) {
      push(
        'bad_hash',
        `${at}.hash`,
        `hash must be 'sha256-' + base64 of 32 bytes, got ${show(raw.hash)}`,
      );
    }
    if (typeof raw.size !== 'number' || !Number.isInteger(raw.size) || raw.size < 0) {
      push('bad_size', `${at}.size`, `size must be an integer >= 0, got ${show(raw.size)}`);
    }
    for (const key of Object.keys(raw)) {
      if (!ENTRY_KEYS.has(key))
        push('bad_shape', `${at}.${key}`, `unknown asset property '${key}'`);
    }
    if (raw.deps !== undefined && !Array.isArray(raw.deps)) {
      push('bad_shape', `${at}.deps`, 'deps must be an array of asset ids');
    }
  }

  // 4. Duplicate urls (exact string compare), reported on the second occurrence.
  const urlOwner = new Map<string, AssetId>();
  for (const [id, raw] of entries) {
    if (typeof raw.url !== 'string') continue;
    const first = urlOwner.get(raw.url);
    if (first === undefined) urlOwner.set(raw.url, id);
    else push('duplicate_url', `assets.${id}.url`, `url '${raw.url}' is already used by ${first}`);
  }

  // 5. Dep lists. Valid edges feed cycle detection.
  const edges = new Map<AssetId, AssetId[]>();
  for (const [id, raw] of entries) {
    const out: AssetId[] = [];
    edges.set(id, out);
    if (!Array.isArray(raw.deps)) continue;
    const seen = new Set<string>();
    raw.deps.forEach((dep: unknown, i) => {
      const at = `assets.${id}.deps[${i}]`;
      if (typeof dep !== 'string') {
        push('bad_shape', at, `dep must be an asset id string, got ${show(dep)}`);
      } else if (seen.has(dep)) {
        push('duplicate_list_entry', at, `dep '${dep}' is listed more than once`);
      } else {
        seen.add(dep);
        if (!ids.has(dep)) push('unknown_dep', at, `dep '${dep}' is not an asset`);
        else if (dep === id) push('self_dep', at, `${id} depends on itself`);
        else out.push(dep);
      }
    });
  }

  // 6. Cycles: iterative white/grey/black DFS from each asset in insertion order.
  const GREY = 1;
  const BLACK = 2;
  const color = new Map<AssetId, number>();
  const reported = new Set<string>();
  for (const start of edges.keys()) {
    if (color.has(start)) continue;
    color.set(start, GREY);
    const stack: { id: AssetId; next: number }[] = [{ id: start, next: 0 }];
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top === undefined) break;
      const deps = edges.get(top.id) ?? [];
      const dep = deps[top.next];
      if (dep === undefined) {
        color.set(top.id, BLACK);
        stack.pop();
        continue;
      }
      top.next += 1;
      const mark = color.get(dep);
      if (mark === undefined) {
        color.set(dep, GREY);
        stack.push({ id: dep, next: 0 });
      } else if (mark === GREY) {
        const cycle = stack.slice(stack.findIndex((f) => f.id === dep)).map((f) => f.id);
        const key = cycleKey(cycle);
        if (!reported.has(key)) {
          reported.add(key);
          push('dep_cycle', `assets.${dep}`, [...cycle, dep].join(' -> '));
        }
      }
    }
  }

  const checkList = (
    list: unknown,
    at: string,
    unknownCode: 'unknown_group_asset' | 'unknown_region_asset',
  ): void => {
    if (!Array.isArray(list)) {
      push('bad_shape', at, 'must be an array of asset ids');
      return;
    }
    const seen = new Set<string>();
    list.forEach((member: unknown, i) => {
      const memberAt = `${at}[${i}]`;
      if (typeof member !== 'string') {
        push('bad_shape', memberAt, `member must be an asset id string, got ${show(member)}`);
      } else if (seen.has(member)) {
        push('duplicate_list_entry', memberAt, `'${member}' is listed more than once`);
      } else {
        seen.add(member);
        if (!ids.has(member)) push(unknownCode, memberAt, `'${member}' is not an asset`);
      }
    });
  };

  // 7. Groups.
  if (!isRecord(input.groups)) {
    push('bad_shape', 'groups', 'groups must be an object keyed by group name');
  } else {
    for (const [name, list] of Object.entries(input.groups)) {
      if (!GROUP_NAME_RE.test(name)) {
        push(
          'bad_group_name',
          `groups.${name}`,
          `group name '${name}' must match ${String(GROUP_NAME_RE)}`,
        );
      }
      checkList(list, `groups.${name}`, 'unknown_group_asset');
    }
  }

  // 8. Regions (region id grammar belongs to docs/world.md).
  if (!isRecord(input.regions)) {
    push('bad_shape', 'regions', 'regions must be an object keyed by region id');
  } else {
    for (const [region, list] of Object.entries(input.regions)) {
      checkList(list, `regions.${region}`, 'unknown_region_asset');
    }
  }
  return errors;
}

/** Throws `ManifestValidationError` unless `validateManifest(input)` is empty. */
export function assertValidManifest(input: unknown): asserts input is Manifest {
  const errors = validateManifest(input);
  if (errors.length > 0) throw new ManifestValidationError(errors);
}

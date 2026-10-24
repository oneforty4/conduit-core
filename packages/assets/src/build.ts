import { createHash } from 'node:crypto';
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  rmdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { sriFromDigest } from './hash.ts';
import {
  MANIFEST_VERSION,
  type AssetEntry,
  type AssetId,
  type AssetType,
  type Manifest,
  type RegionId,
} from './manifest.ts';
import { validateManifest, type ManifestError } from './validate.ts';

export interface BuildOptions {
  srcDir: string;
  outDir: string;
  /** `WorldGraphJson` (docs/world.md); fills `regions`. */
  graphPath?: string;
  /** Default: `config.baseUrl ?? '/assets/'`. */
  baseUrl?: string;
  /** Delete files under `outDir` that this build did not write. Default false. */
  clean?: boolean;
  log?: (line: string) => void;
}

export interface BuildResult {
  manifest: Manifest;
  /** Absolute paths written to `outDir` (content files, then `manifest.json`). */
  written: string[];
  /** Absolute paths deleted by `clean`. */
  removed: string[];
  /** Non-empty => nothing was written. */
  errors: ManifestError[];
}

/** An input that cannot be read or has the wrong shape: `srcDir`, the config file or `--graph`. */
export class BuildInputError extends Error {
  override readonly name = 'BuildInputError';
  /** The offending file or directory, as given. */
  readonly path: string;

  constructor(file: string, message: string) {
    super(message);
    this.path = file;
  }
}

export const CONFIG_FILE = 'conduit-assets.json';
export const DEFAULT_BASE_URL = '/assets/';
export const MANIFEST_FILE = 'manifest.json';

const EXTENSION_TYPES: Readonly<Record<string, AssetType>> = {
  '.glb': 'model',
  '.png': 'texture',
  '.jpg': 'texture',
  '.jpeg': 'texture',
  '.webp': 'texture',
  '.ktx2': 'texture',
  '.ogg': 'audio',
  '.mp3': 'audio',
  '.wav': 'audio',
  '.json': 'json',
  '.bin': 'binary',
  '.gltf': 'binary',
};

interface BuildConfig {
  baseUrl?: string;
  groups: Record<string, string[]>;
  deps: Record<AssetId, AssetId[]>;
}

type Json = Record<string, unknown>;

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/** A record with keys in the given order; safe for keys such as `__proto__`. */
function recordOf<T>(entries: Iterable<readonly [string, T]>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [key, value] of entries) {
    Object.defineProperty(out, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

/** Extension of the last path segment including the dot (`''` for none or a dotfile). */
function extOf(rel: string): string {
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot) : '';
}

/**
 * Asset type for a file extension (with or without the dot, case-insensitive), or `null` when the
 * extension is not an asset type; such files are skipped by `buildManifest` (docs/assets.md §2.1).
 */
export function typeFromExt(ext: string): AssetType | null {
  const key = (ext.startsWith('.') ? ext : `.${ext}`).toLowerCase();
  return Object.hasOwn(EXTENSION_TYPES, key) ? (EXTENSION_TYPES[key] ?? null) : null;
}

/**
 * Asset id for a POSIX path relative to the source directory: drop the extension, lowercase each
 * segment and replace characters outside `[a-z0-9_]` with `_`; a first segment that then starts
 * with `_` loses all its underscores. Join with `.`. The result may still fail `ASSET_ID_RE`
 * (e.g. top-level `sfx_horn.ogg`); validation reports that as `bad_id`.
 */
export function idFromPath(rel: string): AssetId {
  const stem = rel.slice(0, rel.length - extOf(rel).length);
  const segments = stem.split('/').map((s) => s.toLowerCase().replace(/[^a-z0-9_]/g, '_'));
  const first = segments[0];
  if (first?.startsWith('_')) segments[0] = first.replace(/_/g, '');
  return segments.join('.');
}

/**
 * Expands group patterns against the known ids. A pattern is an exact id or `prefix.*` (ids whose
 * leading segments equal `prefix`, with at least one more segment). Members keep pattern order,
 * each pattern's matches sorted, duplicates dropped. A pattern matching nothing, or with `*`
 * anywhere but the final segment, is `unknown_group_asset` at `groups.<name>[i]`.
 */
export function expandPatterns(
  patterns: Readonly<Record<string, readonly string[]>>,
  ids: readonly AssetId[],
): { groups: Record<string, AssetId[]>; errors: ManifestError[] } {
  const sorted = [...ids].sort(compare);
  const known = new Set(ids);
  const errors: ManifestError[] = [];
  const groups: [string, AssetId[]][] = [];
  for (const [name, list] of Object.entries(patterns).sort(([a], [b]) => compare(a, b))) {
    const members: AssetId[] = [];
    const seen = new Set<AssetId>();
    list.forEach((pattern, i) => {
      const at = `groups.${name}[${i}]`;
      let matches: AssetId[];
      if (pattern.length > 2 && pattern.endsWith('.*') && !pattern.slice(0, -2).includes('*')) {
        const prefix = pattern.slice(0, -1); // keeps the trailing '.'
        matches = sorted.filter((id) => id.startsWith(prefix));
      } else if (pattern.includes('*')) {
        errors.push({
          code: 'unknown_group_asset',
          path: at,
          message: `pattern '${pattern}' is invalid: '*' is only allowed as the final segment ('prefix.*')`,
        });
        return;
      } else {
        matches = known.has(pattern) ? [pattern] : [];
      }
      if (matches.length === 0) {
        errors.push({
          code: 'unknown_group_asset',
          path: at,
          message: `pattern '${pattern}' matches no asset`,
        });
        return;
      }
      for (const id of matches) {
        if (seen.has(id)) continue;
        seen.add(id);
        members.push(id);
      }
    });
    groups.push([name, members]);
  }
  return { groups: recordOf(groups), errors };
}

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') return null;
    throw error;
  }
}

function parseJson(file: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new BuildInputError(file, `invalid JSON: ${String(error)}`);
  }
}

function parseConfig(file: string, text: string): BuildConfig {
  const raw = parseJson(file, text);
  if (!isRecord(raw)) throw new BuildInputError(file, 'config must be a JSON object');
  const config: BuildConfig = { groups: {}, deps: {} };
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'baseUrl') {
      if (typeof value !== 'string') throw new BuildInputError(file, 'baseUrl must be a string');
      config.baseUrl = value;
    } else if (key === 'groups' || key === 'deps') {
      if (!isRecord(value) || !Object.values(value).every(isStringArray)) {
        throw new BuildInputError(file, `${key} must map names to arrays of strings`);
      }
      config[key] = value as Record<string, string[]>;
    } else {
      throw new BuildInputError(
        file,
        `unknown config property '${key}' (expected baseUrl, groups, deps)`,
      );
    }
  }
  return config;
}

/**
 * `<srcDir>/conduit-assets.json`, else `conduit-assets.json` in the parent of `srcDir` (a game keeps
 * it next to `world.json`, outside the source directory).
 */
async function readConfig(srcDir: string): Promise<{ file: string | null; config: BuildConfig }> {
  const candidates = [path.join(srcDir, CONFIG_FILE), path.join(path.dirname(srcDir), CONFIG_FILE)];
  for (const file of new Set(candidates)) {
    const text = await readText(file);
    if (text !== null) return { file, config: parseConfig(file, text) };
  }
  return { file: null, config: { groups: {}, deps: {} } };
}

/** Region id -> asset list pairs from a `WorldGraphJson` (only `regions[].id` and `.assets` are read). */
async function readGraphRegions(given: string): Promise<[RegionId, AssetId[]][]> {
  const file = path.resolve(given);
  const text = await readText(file);
  if (text === null) throw new BuildInputError(given, 'world graph file not found');
  const raw = parseJson(given, text);
  if (!isRecord(raw) || !Array.isArray(raw.regions)) {
    throw new BuildInputError(given, 'world graph JSON must have a regions array');
  }
  const seen = new Set<RegionId>();
  return raw.regions.map((def: unknown, i): [RegionId, AssetId[]] => {
    if (!isRecord(def) || typeof def.id !== 'string') {
      throw new BuildInputError(given, `regions[${i}] must be an object with a string id`);
    }
    const assets = def.assets ?? [];
    if (!isStringArray(assets)) {
      throw new BuildInputError(
        given,
        `regions[${i}] (${def.id}) assets must be an array of asset ids`,
      );
    }
    if (seen.has(def.id)) throw new BuildInputError(given, `duplicate region id '${def.id}'`);
    seen.add(def.id);
    return [def.id, [...new Set(assets)]];
  });
}

/**
 * Relative POSIX paths of every file under `srcDir`, sorted, skipping path segments that start with
 * `.` or `_`, the root `conduit-assets.json`, and `outDir` when it lies inside `srcDir`.
 */
async function listSourceFiles(srcDir: string, outDir: string): Promise<string[]> {
  const files: string[] = [];
  const visited = new Set<string>();
  const visit = async (dir: string, rel: string): Promise<void> => {
    const real = await realpath(dir);
    if (visited.has(real)) return; // symlink loop
    visited.add(real);
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
      const abs = path.join(dir, entry.name);
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        const target = await stat(abs).catch(() => null);
        isDirectory = target?.isDirectory() ?? false;
        isFile = target?.isFile() ?? false;
      }
      if (isDirectory && abs !== outDir) await visit(abs, childRel);
      else if (isFile && childRel !== CONFIG_FILE) files.push(childRel);
    }
  };
  await visit(srcDir, '');
  return files.sort(compare);
}

/** `file` relative to the working directory when inside it, else absolute. */
function displayPath(file: string): string {
  const rel = path.relative(process.cwd(), file);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : file;
}

const isWithin = (child: string, parent: string): boolean => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/** Deletes files under `outDir` not in `keep`, then directories left empty. */
async function cleanOutDir(outDir: string, keep: ReadonlySet<string>): Promise<string[]> {
  const removed: string[] = [];
  const visit = async (dir: string): Promise<boolean> => {
    let remaining = 0;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (await visit(abs)) await rmdir(abs);
        else remaining += 1;
      } else if (keep.has(abs)) {
        remaining += 1;
      } else {
        await rm(abs, { force: true });
        removed.push(abs);
      }
    }
    return remaining === 0;
  };
  await visit(outDir);
  return removed.sort(compare);
}

/**
 * Builds `outDir/manifest.json` and content-hashed copies of every asset under `srcDir`
 * (docs/assets.md §2.1). Files whose extension is not an asset type (Blender `.blend` sources,
 * notes) are skipped with a log line. Resolves with `errors` (and writes nothing) on manifest
 * problems; rejects with `BuildInputError` when an input cannot be read.
 */
export async function buildManifest(opts: BuildOptions): Promise<BuildResult> {
  const log = opts.log ?? ((): void => undefined);
  const srcDir = path.resolve(opts.srcDir);
  const outDir = path.resolve(opts.outDir);
  const srcStat = await stat(srcDir).catch(() => null);
  if (srcStat?.isDirectory() !== true) {
    throw new BuildInputError(opts.srcDir, 'source directory not found');
  }
  if (srcDir === outDir) throw new BuildInputError(opts.outDir, 'outDir must differ from srcDir');
  if (opts.clean === true && isWithin(srcDir, outDir)) {
    throw new BuildInputError(opts.outDir, 'refusing to clean an outDir that contains srcDir');
  }

  const { file: configFile, config } = await readConfig(srcDir);
  if (configFile !== null) log(`config ${displayPath(configFile)}`);
  const baseUrl = opts.baseUrl ?? config.baseUrl ?? DEFAULT_BASE_URL;
  const graphRegions = opts.graphPath === undefined ? [] : await readGraphRegions(opts.graphPath);

  const errors: ManifestError[] = [];
  const found = new Map<AssetId, { src: string; entry: AssetEntry }>();
  for (const rel of await listSourceFiles(srcDir, outDir)) {
    const ext = extOf(rel);
    const type = typeFromExt(ext);
    if (type === null) {
      log(`skip ${rel}: ${ext === '' ? 'no extension' : `'${ext}' is not an asset type`}`);
      continue;
    }
    const id = idFromPath(rel);
    const prior = found.get(id);
    if (prior !== undefined) {
      errors.push({
        code: 'bad_id',
        path: `assets.${id}`,
        message: `duplicate id from ${rel} and ${prior.src}`,
      });
      continue;
    }
    const bytes = await readFile(path.join(srcDir, rel));
    const digest = createHash('sha256').update(bytes).digest();
    // <dir>/<name>.<first 8 hex of the digest><ext>, no leading './'.
    const url = `${rel.slice(0, rel.length - ext.length)}.${digest.toString('hex').slice(0, 8)}${ext}`;
    found.set(id, {
      src: rel,
      entry: { type, url, hash: sriFromDigest(digest), size: bytes.length },
    });
  }

  for (const [owner, deps] of Object.entries(config.deps)) {
    const target = found.get(owner);
    if (target === undefined) {
      errors.push({
        code: 'unknown_dep',
        path: `deps.${owner}`,
        message: `deps names unknown asset ${owner}`,
      });
    } else {
      target.entry.deps = [...deps];
    }
  }
  const sources = [...found.entries()].sort(([a], [b]) => compare(a, b));
  const ids = sources.map(([id]) => id);
  const expanded = expandPatterns(config.groups, ids);
  errors.push(...expanded.errors);

  const manifest: Manifest = {
    version: MANIFEST_VERSION,
    baseUrl,
    assets: recordOf(sources.map(([id, { entry }]) => [id, entry] as const)),
    groups: expanded.groups,
    regions: recordOf(graphRegions.sort(([a], [b]) => compare(a, b))),
  };
  for (const error of validateManifest(manifest)) {
    const src =
      error.code === 'bad_id' ? found.get(error.path.slice('assets.'.length))?.src : undefined;
    errors.push(
      src === undefined ? error : { ...error, message: `${error.message} (from ${src})` },
    );
  }
  if (errors.length > 0) return { manifest, written: [], removed: [], errors };

  await mkdir(outDir, { recursive: true });
  const written: string[] = [];
  for (const [, { src, entry }] of sources) {
    const dest = path.join(outDir, ...entry.url.split('/'));
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(path.join(srcDir, src), dest);
    written.push(dest);
  }
  const manifestFile = path.join(outDir, MANIFEST_FILE);
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  written.push(manifestFile);
  const removed = opts.clean === true ? await cleanOutDir(outDir, new Set(written)) : [];
  log(`wrote ${ids.length} assets and ${MANIFEST_FILE} to ${outDir}`);
  if (opts.clean === true) log(`removed ${removed.length} stale files`);
  return { manifest, written, removed, errors: [] };
}

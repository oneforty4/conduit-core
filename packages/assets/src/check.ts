import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseGlb, type GlbParsed } from './glb.ts';
import { sriFromDigest } from './hash.ts';
import type { AssetId, Manifest } from './manifest.ts';
import { deriveModelMeta } from './model-meta.ts';
import { checkModelNaming, type NamingErrorCode } from './naming.ts';
import { validateManifest } from './validate.ts';

export type CheckCode =
  | 'manifest_invalid'
  | 'missing_file'
  | 'size_mismatch'
  | 'hash_mismatch'
  | 'glb_parse'
  | NamingErrorCode;

export interface CheckOptions {
  manifestPath: string;
  /** Directory holding the content files; default the manifest's directory. */
  dir?: string;
  log?: (line: string) => void;
}

export interface CheckFailure {
  /** `null` for failures about the manifest itself. */
  id: AssetId | null;
  code: CheckCode;
  message: string;
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Verifies a built manifest against the files on disk (docs/assets.md §2.2): manifest validity, then
 * for each asset (sorted by id) presence, size, hash and, for models, GLB parsing and the naming
 * conventions. A manifest that cannot be read or parsed is one `manifest_invalid` failure.
 * Resolves `[]` when everything passes.
 */
export async function checkManifest(opts: CheckOptions): Promise<CheckFailure[]> {
  const manifestPath = path.resolve(opts.manifestPath);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    return [
      {
        id: null,
        code: 'manifest_invalid',
        message: `cannot read ${opts.manifestPath}: ${String(error)}`,
      },
    ];
  }
  const invalid = validateManifest(raw);
  if (invalid.length > 0) {
    return invalid.map((e) => ({
      id: null,
      code: 'manifest_invalid',
      message: `${e.code} ${e.path}: ${e.message}`,
    }));
  }
  const manifest = raw as Manifest;
  const dir = opts.dir === undefined ? path.dirname(manifestPath) : path.resolve(opts.dir);
  const failures: CheckFailure[] = [];
  const entries = Object.entries(manifest.assets).sort(([a], [b]) => compare(a, b));
  for (const [id, entry] of entries) {
    const file = path.join(dir, ...entry.url.split('/'));
    const info = await stat(file).catch(() => null);
    if (info?.isFile() !== true) {
      failures.push({ id, code: 'missing_file', message: `${entry.url} not found in ${dir}` });
      continue;
    }
    const bytes = await readFile(file);
    if (bytes.length !== entry.size) {
      failures.push({
        id,
        code: 'size_mismatch',
        message: `${entry.url} is ${bytes.length} bytes; the manifest says ${entry.size}`,
      });
    }
    const hash = sriFromDigest(createHash('sha256').update(bytes).digest());
    if (hash !== entry.hash) {
      failures.push({
        id,
        code: 'hash_mismatch',
        message: `${entry.url} hashes to ${hash}; the manifest says ${entry.hash}`,
      });
    }
    if (entry.type !== 'model') continue;
    let glb: GlbParsed;
    try {
      glb = parseGlb(bytes);
    } catch (error) {
      failures.push({ id, code: 'glb_parse', message: `${entry.url}: ${String(error)}` });
      continue;
    }
    const meta = deriveModelMeta(glb.json, id);
    for (const naming of checkModelNaming(glb.json, meta, id)) {
      failures.push({ id, code: naming.code, message: naming.message });
    }
  }
  opts.log?.(`checked ${entries.length} assets in ${dir}: ${failures.length} failures`);
  return failures;
}

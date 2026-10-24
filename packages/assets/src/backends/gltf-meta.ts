import { fetchBytes, type AssetBackend, type BackendContext } from '../backend.ts';
import { parseGlb } from '../glb.ts';
import type { AssetEntry } from '../manifest.ts';
import { deriveModelMeta, type ModelMeta } from '../model-meta.ts';

/**
 * `model` assets without `three` (docs/assets.md §4, §4.1): the `ModelMeta` of a `.glb` (colliders,
 * sockets, LODs, clip names), for servers and headless clients. Rendering clients register render's
 * `GltfBackend` instead, whose `meta` is the same derivation. The whole file comes through
 * `ctx.fetch` (and is hashed when `ctx.verify`), but only its JSON chunk is parsed: the BIN chunk is
 * never scanned or copied. Isomorphic: bytes arrive only through `ctx.fetch`, so a Node server that
 * reads its built assets from disk injects `AssetLoaderOptions.fetch`. Nothing to dispose.
 */
export class GltfMetaBackend implements AssetBackend<ModelMeta> {
  readonly type = 'model';

  async load(
    url: string,
    entry: AssetEntry,
    signal: AbortSignal,
    ctx: BackendContext,
  ): Promise<ModelMeta> {
    const bytes = await fetchBytes(url, entry, signal, ctx);
    return deriveModelMeta(parseGlb(bytes, { jsonOnly: true }).json, ctx.id);
  }

  dispose(_meta: ModelMeta): void {
    // Plain data: the garbage collector reclaims it.
  }
}

import { fetchBytes, type AssetBackend, type BackendContext } from '../backend.ts';
import type { AssetEntry } from '../manifest.ts';

/** `json` assets: the parsed document (`unknown`). Nothing to dispose. */
export class JsonBackend implements AssetBackend<unknown> {
  readonly type = 'json';

  async load(
    url: string,
    entry: AssetEntry,
    signal: AbortSignal,
    ctx: BackendContext,
  ): Promise<unknown> {
    const bytes = await fetchBytes(url, entry, signal, ctx);
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  dispose(_asset: unknown): void {
    // Plain data: the garbage collector reclaims it.
  }
}

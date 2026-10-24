import type { ResourceEstimate } from '../resources.ts';
import { fetchBytes, type AssetBackend, type BackendContext } from '../backend.ts';
import type { AssetEntry } from '../manifest.ts';

/** `binary` assets: the raw bytes. Nothing to dispose. */
export class BinaryBackend implements AssetBackend<ArrayBuffer> {
  readonly type = 'binary';

  load(
    url: string,
    entry: AssetEntry,
    signal: AbortSignal,
    ctx: BackendContext,
  ): Promise<ArrayBuffer> {
    return fetchBytes(url, entry, signal, ctx);
  }

  estimate(asset: ArrayBuffer): ResourceEstimate {
    return {
      resources: [
        {
          identity: asset,
          cpuBytes: asset.byteLength,
          gpuBytes: 0,
          retainedSourceBytes: asset.byteLength,
        },
      ],
    };
  }

  dispose(_asset: ArrayBuffer): void {
    // Plain bytes: the garbage collector reclaims them.
  }
}

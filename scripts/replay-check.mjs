#!/usr/bin/env node
// The adapter exports replayFactory. Journal files use encodeExactState, preserving undefined/-0.
import { open } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import {
  MAX_EXACT_STATE_BYTES,
  decodeExactState,
  replayCommandJournal,
} from '../packages/sim/src/index.ts';
const [, , recordingPath, adapterPath] = process.argv;
if (!recordingPath || !adapterPath) {
  console.error('Usage: node scripts/replay-check.mjs JOURNAL.exact ADAPTER.mjs');
  process.exitCode = 2;
} else {
  try {
    const handle = await open(recordingPath, 'r');
    let bytes;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size > MAX_EXACT_STATE_BYTES)
        throw new RangeError('Journal file exceeds bounded regular-file input contract');
      const buffer = new Uint8Array(stat.size + 1);
      let used = 0;
      while (used < buffer.length) {
        const result = await handle.read(buffer, used, buffer.length - used, null);
        if (result.bytesRead === 0) break;
        used += result.bytesRead;
      }
      if (used > stat.size) throw new RangeError('Journal file grew during bounded read');
      bytes = buffer.subarray(0, used);
    } finally {
      await handle.close();
    }
    const journal = decodeExactState(bytes);
    const adapter = await import(pathToFileURL(resolve(adapterPath)).href);
    if (!adapter.replayFactory || typeof adapter.replayFactory.createRun !== 'function')
      throw new TypeError(
        'Adapter must export replayFactory.createRun; use recorded-result handlers and disabled external sinks',
      );
    const result = await replayCommandJournal(adapter.replayFactory, journal);
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

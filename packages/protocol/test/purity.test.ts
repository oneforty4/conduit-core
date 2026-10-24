import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

const BANNED: [string, RegExp][] = [
  ['Date', /\bDate\b/],
  ['Math.random', /\bMath\s*\.\s*random\b/],
  ['setTimeout', /\bsetTimeout\b/],
  ['setInterval', /\bsetInterval\b/],
  ['performance', /\bperformance\b/],
  ['process', /\bprocess\b/],
  ['fetch', /\bfetch\b/],
  ['require', /\brequire\b/],
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (/\.[cm]?[jt]s$/.test(entry.name)) out.push(path);
  }
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function violations(text: string): string[] {
  const found: string[] = [];
  text.split('\n').forEach((line, i) => {
    for (const [name, re] of BANNED) if (re.test(line)) found.push(`${name} on line ${i + 1}`);
  });
  return found;
}

describe('purity', () => {
  it('scans every source file', () => {
    const files = sourceFiles(SRC).map((p) => relative(SRC, p));
    expect(files).toEqual(
      expect.arrayContaining([
        'bytes.ts',
        'constants.ts',
        'define.ts',
        'envelope.ts',
        'errors.ts',
        'events.ts',
        'fields.ts',
        'hash.ts',
        'index.ts',
        'messages.ts',
        'quant.ts',
        'registry.ts',
        'schema.ts',
        'snapshot.ts',
        'utf8.ts',
      ]),
    );
  });

  it('the patterns catch what they should and ignore look-alikes', () => {
    expect(violations('const t = Date.now();')).toEqual(['Date on line 1']);
    expect(violations('x = Math.random()')).toEqual(['Math.random on line 1']);
    expect(violations('setTimeout(f, 1); setInterval(f, 1)')).toEqual([
      'setTimeout on line 1',
      'setInterval on line 1',
    ]);
    expect(violations('performance.now()\nprocess.env.X\nawait fetch(u)\nrequire("x")')).toEqual([
      'performance on line 1',
      'process on line 2',
      'fetch on line 3',
      'require on line 4',
    ]);
    expect(violations('SnapshotUpdate; processed; prefetch; required; Dates')).toEqual([]);
  });

  it('no source file under src/ references wall clock, randomness, timers, I/O or require', () => {
    const report: string[] = [];
    for (const file of sourceFiles(SRC)) {
      for (const v of violations(readFileSync(file, 'utf8')))
        report.push(`${relative(SRC, file)}: ${v}`);
    }
    expect(report).toEqual([]);
  });
});

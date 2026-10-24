// Reads `pnpm why -r three --json` from stdin; exits 1 unless exactly one `three` version is resolved.
let src = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) src += chunk;
const versions = new Set();
const walk = (n) => {
  if (!n || typeof n !== 'object') return;
  if (Array.isArray(n)) return n.forEach(walk);
  // pnpm 11: one top-level entry per resolved copy, `{ name, version, dependents }`.
  if (n.name === 'three' && typeof n.version === 'string' && Array.isArray(n.dependents))
    versions.add(n.version);
  // pnpm 9: importer trees whose dependency nodes carry `from`.
  if (n.from === 'three' && typeof n.version === 'string') versions.add(n.version);
  for (const k of ['dependencies', 'devDependencies', 'peerDependencies'])
    if (n[k]) walk(Object.values(n[k]));
};
walk(JSON.parse(src || '[]'));
if (versions.size !== 1) {
  console.error('three versions resolved:', [...versions]);
  process.exit(1);
}
console.log('three resolves to a single version:', [...versions][0]);

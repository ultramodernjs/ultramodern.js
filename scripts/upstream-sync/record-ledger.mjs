import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  DEFAULT_DIVERGENCE_BASE_REF,
  DEFAULT_UPSTREAM_PROVENANCE_REF,
  measureRule5Changes,
  renderLedgerEvidence,
} = require('../ultramodern-boundary-check/divergence.js');
const [base, head, upstream, mode] = process.argv.slice(2);
assert(
  base && head && upstream,
  'Usage: record-ledger.mjs <PR-base> <source-head> <upstream> [--write]',
);
assert(mode === undefined || mode === '--write');
const file = 'FORK-DIVERGENCE.md';
const original = fs.readFileSync(file, 'utf8');
const pattern =
  /(<!-- fork-evidence:v1 -->\s*```json\s*)([\s\S]*?)(\s*```\s*<!-- \/fork-evidence:v1 -->)/;
const match = pattern.exec(original);
assert(match, 'Expected one structured fork evidence block');
const document = JSON.parse(match[2]);
const entries = new Map(document.entries.map(entry => [entry.path, entry]));
const changes = measureRule5Changes({
  rootDir: process.cwd(),
  auditedBaseRef: DEFAULT_DIVERGENCE_BASE_REF,
  upstreamRef: DEFAULT_UPSTREAM_PROVENANCE_REF,
  mergeBaseRef: base,
  headRef: head,
  pathspec: ['packages'],
}).filter(change => !change.genuineShrink);

function blob(ref, path) {
  const result = execFileSync('git', ['ls-tree', ref, '--', path], {
    encoding: 'utf8',
  });
  return result.split(/\s+/)[2];
}

function retainedContract(path) {
  if (path.endsWith('/package.json'))
    return 'qualified dependency cohort, compiled exports, and native build scripts';
  if (/rslib|rstest|tsconfig/.test(path))
    return 'direct Rslib builds and checked Effect-enabled TypeScript 7 declarations';
  if (path.startsWith('packages/runtime/'))
    return 'request-scoped rendering, worker cancellation, native context identity, and provider-selected routing';
  if (path.startsWith('packages/server/'))
    return 'Effect and worker contracts, federation lifecycle, responder hooks, and response-byte correctness';
  if (path.startsWith('packages/solutions/'))
    return 'native TypeScript loading, fork extension seams, and compiled public declarations';
  if (path.startsWith('packages/toolkit/'))
    return 'native ESM loading, neutral type ownership, and distinct vanilla/UltraModern generator contracts';
  if (path.startsWith('packages/cli/'))
    return 'fork extension seams, worker bundling, and native server/router contracts';
  return 'documented UltraModern behavior and upstream improvements';
}

for (const change of changes) {
  const current = change.currentPaths[0];
  const exact =
    current &&
    blob(head, current) &&
    blob(head, current) === blob(upstream, current);
  const reason = exact
    ? `2026-11-13: Adopt exact upstream ${upstream} source for this identity without introducing fork behavior.`
    : `2026-11-13: Reconcile upstream ${upstream} while preserving ${retainedContract(current ?? change.file)}; remove superseded code rather than restoring upstream legacy paths.`;
  const old = entries.get(change.file);
  entries.set(change.file, {
    path: change.file,
    owner: 'bleedingdev',
    reason:
      old && !old.reason.includes(reason) ? `${old.reason} ${reason}` : reason,
    dispositions: [
      ...new Set([
        ...(old?.dispositions ?? []),
        exact ? 'upstream-PR' : 'inline-patch',
      ]),
    ],
  });
}
document.entries = [...entries.values()];
const json = `{\n  "schemaVersion": 1,\n  "entries": [\n${document.entries.map(entry => `    ${JSON.stringify(entry)}`).join(',\n')}\n  ]\n}`;
const updated = original.replace(
  pattern,
  (_, prefix, _body, suffix) => `${prefix}${json}${suffix}`,
);
if (mode === '--write') fs.writeFileSync(file, renderLedgerEvidence(updated));
console.log(
  `${mode === '--write' ? 'Recorded' : 'Measured'} ${changes.length} non-shrink upstream-owned identities; audited base and provenance unchanged.`,
);

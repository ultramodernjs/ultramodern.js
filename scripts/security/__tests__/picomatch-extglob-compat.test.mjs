// Positive compatibility fixtures for the canonical picomatch extglob
// correction. Every installed picomatch@2.3.2 and picomatch@4.0.7 copy, and a
// copy of it with patches/picomatch@<version>.patch applied exactly, must keep
// the matches below: large benign extglobs still compile to working regexes,
// and upstream suite expectations hold where the correction compiles a
// repeated extglob without repetition.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(import.meta.url);
const scratches = [];

const words = Array.from({ length: 300 }, (_, index) => `word${index}`);
const extensions = Array.from({ length: 50 }, (_, index) => `*.e${index}`);

const fixtures = [
  // Large benign families: a literal word list, many extensions, a long
  // literal and deep non-repeated nesting.
  {
    pattern: `*(${words.join('|')})`,
    match: ['word0', 'word17word299', 'word10word1'],
    miss: ['wordx', 'word300'],
  },
  {
    pattern: `+(${extensions.join('|')})`,
    match: ['a.e3', 'b.e49', 'x.e1.e2'],
    miss: ['a.e50', 'a/b.e1'],
  },
  {
    pattern: `+(${'abc'.repeat(3000)})`,
    match: ['abc'.repeat(3000), 'abc'.repeat(6000)],
    miss: ['abc'],
  },
  {
    pattern: `+(x${'@('.repeat(100)}a${')'.repeat(100)})`,
    match: ['xa', 'xaxa'],
    miss: ['xb'],
  },
  // Upstream suite expectations.
  { pattern: '*(!(f))', match: ['fff', 'foo', 'ooo'], miss: ['f', 'foo/bar'] },
  { pattern: '+(!(f))', match: ['fff', 'foo', 'ooo'], miss: ['f'] },
  { pattern: '*(!(foo))', match: ['bar', 'baz', 'foobar'], miss: ['foo'] },
  { pattern: '*(a*|b)', match: ['ax', 'bax', 'b'], miss: ['xa'] },
  {
    pattern: '+(*.js|*.ts)',
    match: ['a.js', 'b.ts', 'a.js.ts'],
    miss: ['a.md', 'a/b.js'],
  },
  {
    pattern: '*/*(W*, *)*',
    match: ['my/folder (Work, Accts)'],
    miss: ['my/folder/(Work, Accts)'],
  },
  {
    pattern: '*(a|{b|c,c})',
    match: ['a', 'ab', 'cb', 'bc'],
    miss: ['d', 'ad'],
  },
  { pattern: '*(foo|bar)', match: ['foobar', 'barfoo'], miss: ['baz'] },
  {
    pattern: '+(+(a))',
    options: { maxExtglobRecursion: 1 },
    match: ['a', 'aaa'],
    miss: ['b'],
  },
  // Other numeric depths keep matching, whether or not they are the explicit
  // whole-number opt-in.
  ...[2, Number.NaN, Number.POSITIVE_INFINITY, 1.5].map(depth => ({
    pattern: '+(+(a))',
    options: { maxExtglobRecursion: depth },
    match: ['a', 'aaa'],
    miss: ['b'],
  })),
];

const installedCopies = version => {
  const store = path.join(repositoryRoot, 'node_modules/.pnpm');
  const copies = fs
    .readdirSync(store)
    .filter(
      name =>
        name === `picomatch@${version}` ||
        name.startsWith(`picomatch@${version}_`),
    )
    .map(name => path.join(store, name, 'node_modules/picomatch'));
  assert.ok(copies.length > 0, `picomatch@${version} is installed`);
  return copies;
};

// The installed copy with the canonical patch applied at zero fuzz and no
// offset, unless the installed copy already carries it.
const correctedCopy = (version, directory) => {
  if (fs.existsSync(path.join(directory, 'lib/repetition.js')))
    return directory;

  const scratch = fs.mkdtempSync(
    path.join(process.env.OWNED_TEMP_DIR ?? os.tmpdir(), 'picomatch-compat-'),
  );
  scratches.push(scratch);
  fs.cpSync(directory, scratch, { recursive: true, dereference: true });

  const applied = spawnSync(
    'patch',
    [
      '-p1',
      '--fuzz=0',
      '--forward',
      '--batch',
      '-i',
      path.join(repositoryRoot, `patches/picomatch@${version}.patch`),
    ],
    { cwd: scratch, encoding: 'utf8' },
  );
  const output = `${applied.stdout}${applied.stderr}`;
  assert.equal(
    applied.status,
    0,
    `picomatch@${version} canonical patch applies:\n${output}`,
  );
  assert.doesNotMatch(
    output,
    /offset|fuzz/iu,
    `picomatch@${version} canonical patch applies exactly`,
  );
  return scratch;
};

test.after(() => {
  for (const scratch of scratches)
    fs.rmSync(scratch, { recursive: true, force: true });
});

for (const version of ['2.3.2', '4.0.7']) {
  test(`picomatch@${version} keeps positive extglob matches with and without the correction`, () => {
    for (const installed of installedCopies(version)) {
      for (const directory of new Set([
        installed,
        correctedCopy(version, installed),
      ])) {
        const picomatch = require(directory);
        const subject = `${path.relative(repositoryRoot, installed)}${directory === installed ? '' : ' (corrected)'}`;

        for (const { pattern, options = {}, match, miss } of fixtures) {
          for (const platform of [{}, { windows: true }]) {
            const settings = { ...options, ...platform };
            const label = `${subject} ${pattern.slice(0, 40)} ${JSON.stringify(settings)}`;

            for (const input of match) {
              assert.ok(
                picomatch.isMatch(input, pattern, settings),
                `${label} matches ${input.slice(0, 40)}`,
              );
            }
            for (const input of miss) {
              assert.ok(
                !picomatch.isMatch(input, pattern, settings),
                `${label} rejects ${input.slice(0, 40)}`,
              );
            }
          }
        }

        assert.ok(
          picomatch.isMatch('WORD5word6', `*(${words.join('|')})`, {
            nocase: true,
          }),
          `${subject} nocase word list`,
        );

        // Capture keeps its group count and the whole repeated region.
        const captured = picomatch
          .makeRe('+(*.js|*.ts)', { capture: true })
          .exec('a.js.ts');
        assert.equal(captured.length, 4, `${subject} capture group count`);
        assert.equal(
          captured[1],
          'a.js.ts',
          `${subject} captures the repeated region`,
        );
      }
    }
  });
}

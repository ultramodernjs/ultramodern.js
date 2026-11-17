import assert from 'node:assert/strict';
import test from 'node:test';
import { requiredRendererFeatureRows } from './feature-gates.mjs';
import {
  createReleaseSteps,
  oneAtATime,
  rendererFeatureRowLanes,
  runLanes,
  settled,
} from './release-steps.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));

test('every required renderer feature row is scheduled exactly once', () => {
  const scheduled = rendererFeatureRowLanes.flatMap(lane => lane.rows);
  assert.equal(new Set(scheduled).size, scheduled.length);
  assert.deepEqual(
    scheduled.toSorted(),
    Object.keys(requiredRendererFeatureRows).toSorted(),
  );
  // generated-solid rebuilds the installed Solid consumer the Solid specs
  // build, so it may only start after them.
  assert.deepEqual(
    rendererFeatureRowLanes.find(lane => lane.rows.includes('generated-solid'))
      .after,
    'solid specs',
  );
  for (const lane of rendererFeatureRowLanes)
    if (!lane.rows.includes('generated-solid'))
      assert.equal(lane.after, 'octane installed');
  // The two compiled-Worker rows never share a lane start.
  const workerLanes = rendererFeatureRowLanes.filter(lane =>
    lane.rows.some(row => row.endsWith('-worker')),
  );
  assert.equal(workerLanes.length, 2);
});

test('lanes wait for their gate, run side by side, and keep order inside a lane', async () => {
  const events = [];
  const gates = { first: settled(), second: settled() };
  const finish = {};
  const run = row =>
    new Promise(resolve => {
      events.push(`start ${row}`);
      finish[row] = () => {
        events.push(`end ${row}`);
        resolve();
      };
    });
  const done = runLanes(
    [
      { after: 'first', rows: ['a1', 'a2'] },
      { after: 'first', rows: ['b1'] },
      { after: 'second', rows: ['c1'] },
    ],
    { first: gates.first.promise, second: gates.second.promise },
    run,
  );
  await tick();
  assert.deepEqual(events, [], 'No lane starts before its gate settles');
  gates.first.settle();
  await tick();
  assert.deepEqual(events, ['start a1', 'start b1']);
  finish.b1();
  await tick();
  assert.deepEqual(events.slice(2), ['end b1']);
  finish.a1();
  await tick();
  assert.deepEqual(events.slice(3), ['end a1', 'start a2']);
  gates.second.settle();
  await tick();
  assert.deepEqual(events.slice(5), ['start c1']);
  finish.a2();
  finish.c1();
  await done;
});

test('a failed row is recorded and its lane goes on; every row executes once', async () => {
  const { step, results } = createReleaseSteps({
    describeFailure: error => ({ summary: error.message, detail: '' }),
    write: () => {},
  });
  const executed = {};
  const gate = Promise.resolve();
  await runLanes(
    rendererFeatureRowLanes,
    { 'octane installed': gate, 'solid specs': gate },
    row =>
      step(row, async () => {
        await tick();
        if (row === 'localized-navigation') throw new Error('version check');
        executed[row] = (executed[row] ?? 0) + 1;
      }),
  );
  assert.deepEqual(
    Object.keys(executed).toSorted(),
    Object.keys(requiredRendererFeatureRows)
      .filter(row => row !== 'localized-navigation')
      .toSorted(),
  );
  assert(Object.values(executed).every(count => count === 1));
  assert.deepEqual(
    results.filter(r => r.status === 'FAIL').map(r => r.name),
    ['localized-navigation'],
  );
});

test('the schedule refuses a row twice or an unknown gate', async () => {
  await assert.rejects(
    runLanes(
      [
        { after: 'g', rows: ['x'] },
        { after: 'g', rows: ['x'] },
      ],
      { g: Promise.resolve() },
      () => {},
    ),
    /scheduled more than once/u,
  );
  await assert.rejects(
    runLanes([{ after: 'missing', rows: ['x'] }], {}, () => {}),
    /No schedule gate named missing/u,
  );
});

test('steps that overlap book their own time and status', async () => {
  let clock = 0;
  const { step, results, table } = createReleaseSteps({
    describeFailure: error => ({ summary: error.message, detail: '' }),
    write: () => {},
    now: () => clock,
  });
  const gates = { long: settled(), short: settled() };
  const long = step('long', () => gates.long.promise);
  clock = 2000;
  const short = step('short', async () => {
    await gates.short.promise;
    throw new Error('short failed');
  });
  clock = 3000;
  gates.short.settle();
  assert.equal(await short, false);
  clock = 9000;
  gates.long.settle();
  assert.equal(await long, true);
  assert.equal(await step('skipped', () => {}, false), false);
  assert.deepEqual(
    results.map(({ name, status, start, seconds, error }) => ({
      name,
      status,
      start,
      seconds,
      error,
    })),
    [
      { name: 'long', status: 'PASS', start: 0, seconds: 9, error: '' },
      {
        name: 'short',
        status: 'FAIL',
        start: 2,
        seconds: 1,
        error: 'short failed',
      },
      { name: 'skipped', status: 'SKIP', start: 9, seconds: 0, error: '' },
    ],
  );
  assert.match(table(), /^long +PASS +@0 +9$/mu);
  assert.match(table(), /^short +FAIL +@2 +1 +short failed$/mu);
});

test('one at a time runs bodies in call order, past a failure', async () => {
  const take = oneAtATime();
  const events = [];
  const gate = settled();
  const first = take(async () => {
    events.push('first');
    await gate.promise;
    throw new Error('first failed');
  });
  const second = take(async () => {
    events.push('second');
  });
  await tick();
  assert.deepEqual(events, ['first']);
  gate.settle();
  await assert.rejects(first, /first failed/u);
  await second;
  assert.deepEqual(events, ['first', 'second']);
});

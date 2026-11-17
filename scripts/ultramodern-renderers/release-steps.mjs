// The step table and the schedule of the packed-release acceptance
// (release.mjs), kept apart so they can be tested without running a release.

/**
 * Required renderer feature rows, as lanes that run side by side. Each lane
 * starts once its `after` gate has settled and runs its rows one after another.
 *
 * - The Octane rows read the installed Octane consumer only, so they start as
 *   soon as it is installed; they write only under their own feature-<row>.
 * - generated-solid rebuilds and serves the installed Solid consumer, the tree
 *   the Solid specs build, so it starts after those specs.
 * - Two Octane lanes, not one per row: the two compiled-Worker rows are the
 *   CPU-bound ones (three production builds each), so each lane pairs one of
 *   them with a row that mostly waits on servers and a browser.
 */
export const rendererFeatureRowLanes = [
  { after: 'octane installed', rows: ['prebuilt-worker', 'dev-refresh'] },
  {
    after: 'octane installed',
    rows: ['localized-navigation', 'generated-worker'],
  },
  { after: 'solid specs', rows: ['generated-solid'] },
];

/**
 * Run `lanes` side by side. A lane waits for `gates[lane.after]`, then hands
 * each of its rows to `run` in order. A failed row does not stop its lane:
 * `run` records the failure, exactly as the serial loop did.
 */
export async function runLanes(lanes, gates, run) {
  const rows = lanes.flatMap(lane => lane.rows);
  if (new Set(rows).size !== rows.length)
    throw new Error('A feature row is scheduled more than once');
  for (const lane of lanes)
    if (!(lane.after in gates))
      throw new Error(`No schedule gate named ${lane.after}`);
  await Promise.all(
    lanes.map(async lane => {
      await gates[lane.after];
      for (const row of lane.rows) await run(row);
    }),
  );
}

/** One body at a time, in call order, whatever an earlier body did. */
export function oneAtATime() {
  let tail = Promise.resolve();
  return body => {
    const run = tail.then(body);
    tail = run.catch(() => {});
    return run;
  };
}

/** A deferred that only ever resolves: schedule gates mark "settled". */
export function settled() {
  let settle;
  const promise = new Promise(resolve => {
    settle = resolve;
  });
  return { promise, settle };
}

/**
 * The PASS/FAIL/SKIP table. Each step owns its record, so steps that run at
 * the same time cannot book their time or status on each other. Records are
 * kept in start order with the start offset, so the table shows the overlap.
 */
export function createReleaseSteps({
  describeFailure,
  write = text => process.stdout.write(text),
  now = () => performance.now(),
}) {
  const origin = now();
  const results = [];
  /** Runs one table row. Returns false (and runs nothing) once `when` fails. */
  async function step(name, body, when = true) {
    const started = now();
    const record = {
      name,
      status: 'SKIP',
      start: (started - origin) / 1000,
      seconds: 0,
      error: '',
    };
    results.push(record);
    if (!when) return false;
    write(`[release] ${name} ...\n`);
    try {
      await body();
      record.status = 'PASS';
      return true;
    } catch (error) {
      const { summary, detail } = describeFailure(error);
      record.status = 'FAIL';
      record.error = summary;
      write(`[release] ${name} FAIL\n${detail}\n`);
      return false;
    } finally {
      record.seconds = (now() - started) / 1000;
    }
  }
  function table() {
    const rows = results.map(r => [
      r.name,
      r.status,
      `@${r.start.toFixed(0)}`,
      r.seconds.toFixed(0),
      r.error.slice(0, 120),
    ]);
    const widths = [0, 1, 2, 3].map(i =>
      Math.max(...rows.map(row => row[i].length)),
    );
    return rows
      .map(row =>
        row
          .map((cell, i) => (i < 4 ? cell.padEnd(widths[i]) : cell))
          .join('  ')
          .trimEnd(),
      )
      .join('\n');
  }
  return { step, results, table };
}

#!/usr/bin/env node
// Measures how many of a Linux runner's cores a job step keeps busy, so a
// runner size is chosen from observed load rather than guessed.
//
//   cpu-usage.mjs start  --out <file>            sample /proc/stat every 2 s
//   cpu-usage.mjs report --out <file> --label L  stop sampling, summarize
//
// The report goes to stdout and, when present, to $GITHUB_STEP_SUMMARY. It
// never fails the job: a missing sample file reports "no samples". The log
// also gets a timeline (busy cores per 10 s window from the first sample's
// time), so a saturated phase can be matched to the step that ran then.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const intervalMs = 2000;

function readCpuLine() {
  return fs.readFileSync('/proc/stat', 'utf8').split('\n', 1)[0];
}

// One aggregate "cpu" line: user nice system idle iowait irq softirq steal.
function parseCpuLine(line) {
  const fields = line.trim().split(/\s+/u).slice(1).map(Number);
  const total = fields.slice(0, 8).reduce((sum, value) => sum + value, 0);
  const idle = fields[3] + fields[4];
  return { total, idle };
}

export function summarize(text, cores) {
  const samples = text
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [at, ...cpu] = line.split(' ');
      return { at: Number(at), ...parseCpuLine(cpu.join(' ')) };
    });
  const busy = [];
  const windows = [];
  for (let index = 1; index < samples.length; index += 1) {
    const total = samples[index].total - samples[index - 1].total;
    const idle = samples[index].idle - samples[index - 1].idle;
    if (total <= 0) continue;
    const value = ((total - idle) / total) * cores;
    busy.push(value);
    const window = Math.floor((samples[index].at - samples[0].at) / 10_000);
    (windows[window] ??= []).push(value);
  }
  if (busy.length === 0) return undefined;
  const sorted = [...busy].sort((a, b) => a - b);
  const pick = fraction =>
    sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
  return {
    cores,
    seconds: Math.round((samples.at(-1).at - samples[0].at) / 1000),
    mean: busy.reduce((sum, value) => sum + value, 0) / busy.length,
    p50: pick(0.5),
    p90: pick(0.9),
    max: sorted.at(-1),
    saturatedShare:
      busy.filter(value => value >= cores * 0.9).length / busy.length,
    startedAt: new Date(samples[0].at).toISOString(),
    timeline: Array.from(windows, values =>
      values
        ? values.reduce((sum, value) => sum + value, 0) / values.length
        : undefined,
    ),
  };
}

function start(out) {
  fs.writeFileSync(out, '');
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), 'sample', '--out', out],
    { detached: true, stdio: 'ignore' },
  );
  fs.writeFileSync(`${out}.pid`, String(child.pid));
  child.unref();
}

function sample(out) {
  const write = () =>
    fs.appendFileSync(out, `${Date.now()} ${readCpuLine()}\n`);
  write();
  setInterval(write, intervalMs);
}

function report(out, label) {
  try {
    process.kill(Number(fs.readFileSync(`${out}.pid`, 'utf8')));
  } catch {}
  let text = '';
  try {
    text = `${fs.readFileSync(out, 'utf8')}${Date.now()} ${readCpuLine()}\n`;
  } catch {}
  const result = text ? summarize(text, os.availableParallelism()) : undefined;
  const line = result
    ? `${label}: ${result.cores} vCPUs over ${result.seconds} s; busy cores mean ${result.mean.toFixed(1)}, p50 ${result.p50.toFixed(1)}, p90 ${result.p90.toFixed(1)}, max ${result.max.toFixed(1)}; ${(result.saturatedShare * 100).toFixed(0)}% of samples at >= 90% of all cores`
    : `${label}: no CPU samples`;
  console.log(line);
  if (result)
    console.log(
      `${label} timeline from ${result.startedAt}, busy cores per 10 s: ${result.timeline.map(value => value?.toFixed(1) ?? '-').join(' ')}`,
    );
  if (process.env.GITHUB_STEP_SUMMARY)
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { out: { type: 'string' }, label: { type: 'string' } },
  });
  const [command] = positionals;
  if (!values.out) throw new Error('--out is required');
  if (command === 'start') start(values.out);
  else if (command === 'sample') sample(values.out);
  else if (command === 'report') report(values.out, values.label ?? 'CPU');
  else throw new Error(`Unknown command ${command}`);
}

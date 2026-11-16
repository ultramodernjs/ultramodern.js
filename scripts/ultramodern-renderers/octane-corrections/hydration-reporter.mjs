import fs from 'node:fs';

/** Extend the owning Vitest reporter with its real deterministic task IDs. */
export function hydrationReporterSource(reportFile) {
  return `
import fs from 'node:fs';
import {JsonReporter} from 'vitest/node';
export default class HydrationReporter extends JsonReporter {
 constructor(){super({});}
 async onTestRunEnd(modules, errors, reason) {
  for(const module of modules)
   for(const test of module.children.allTests())
    test.task.meta.octaneTaskId=test.id;
  await super.onTestRunEnd(modules);
  const file=${JSON.stringify(reportFile)};
  const report=JSON.parse(fs.readFileSync(file,'utf8'));
  report.unhandledErrors=errors;
  report.runEndReason=reason;
  fs.writeFileSync(file,JSON.stringify(report,null,2));
 }
}`;
}

export function writeHydrationReporter(file, reportFile) {
  fs.writeFileSync(file, hydrationReporterSource(reportFile));
}

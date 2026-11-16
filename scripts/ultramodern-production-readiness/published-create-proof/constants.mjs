import path from 'node:path';
import fsKit from '../../lib/fs-kit.js';
import processKit from '../../lib/process-kit.js';

export const { readJsonFile, repoRoot, writeJsonFile } = fsKit;
export const { createProcessEnv, runCommand } = processKit;
export const defaultProjectName = 'ultramodern-ci-superapp';
export const browserSmokeScript = path.join(
  repoRoot,
  'scripts/ultramodern-production-readiness/run-browser-smoke.mjs',
);
export const browserSmokePlaywrightPackage =
  process.env.ULTRAMODERN_BROWSER_SMOKE_PLAYWRIGHT_PACKAGE ??
  'playwright@1.65.1';
export const readableErpVerticalNames = [
  'inventory',
  'finance',
  'people',
  'analytics',
  'orders',
  'procurement',
  'billing',
  'logistics',
  'support',
  'compliance',
];
export const scaleProfiles = Object.freeze({
  'erp-10': Object.freeze({
    id: 'erp-10',
    verticalCount: 10,
  }),
});

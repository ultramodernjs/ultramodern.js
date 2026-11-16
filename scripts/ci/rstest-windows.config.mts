import { fileURLToPath } from 'node:url';
import {
  assertWindowsCoverage,
  loadWindowsUnitInputs,
  selectWindowsUnitFiles,
  windowsLaneSeconds,
  windowsUnitConfig,
} from './windows-unit-selection.mjs';

export default async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const { base, loadConfig, createRstest } = await loadWindowsUnitInputs(root);
  const original = await createRstest({ cwd: root, config: base });
  const baseline = await original.listTests({ filesOnly: true });
  const lane = process.env.WINDOWS_UNIT_LANE;
  const config = await windowsUnitConfig(
    root,
    base,
    loadConfig,
    lane,
    baseline,
  );
  const selected = await createRstest({ cwd: root, config });
  const files = await selected.listTests({ filesOnly: true });
  assertWindowsCoverage(selectWindowsUnitFiles(root, baseline, lane), [files]);
  console.log(
    JSON.stringify({
      windowsUnitLane: lane,
      projectFileIdentities: files.length,
      modelledSeconds: Number(
        windowsLaneSeconds(root, baseline, lane).toFixed(1),
      ),
      testFileWorkers: 1,
    }),
  );
  return config;
};

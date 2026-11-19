---
'@modern-js/utils': patch
'@modern-js/bff-core': patch
'@modern-js/plugin': patch
---

Remove the `globby` and `globbySync` exports, the `GlobbyOptions` type and the `@modern-js/utils/globby` subpath, and drop the `fast-glob` dependency, so `@modern-js/utils` no longer brings `micromatch` and `picomatch` into production installs. Use `glob` or `globSync` from `node:fs` instead. `@modern-js/bff-core` now finds API handlers with `globSync` from `node:fs` and still applies the `.gitignore` files inside the API directory. `@modern-js/plugin` drops the unused internal `clearFilesOverTime` helper.

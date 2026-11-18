---
'@modern-js/utils': patch
---

Remove the `fastGlob` export and the `@modern-js/utils/fast-glob` subpath. No framework package used them; use `fs.glob` or `fs.globSync` from `node:fs` instead. `fast-glob` stays a dependency only because the bundled `globby` loads it at run time.

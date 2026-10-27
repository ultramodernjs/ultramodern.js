---
'@modern-js/server-utils': patch
'@modern-js/app-tools': patch
'@modern-js/plugin-bff': patch
---

Honor output.sourceMap when compiling server and BFF sources with Rslib so production builds can disable source maps without deleting emitted files.

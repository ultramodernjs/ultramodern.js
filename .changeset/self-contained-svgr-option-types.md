---
'@modern-js/app-tools-extensions': patch
'@modern-js/app-tools': patch
'@modern-js/ultramodern-app-tools': patch
---

Type `tools.svgr` from self-contained declarations of the SVGR, Babel 7, SVGO and Prettier packages SVGR runs with, so library-checked consumers no longer fail with TS2614/TS2305 when their install hoists Babel 8, and drop the type-only `@types/babel__core` and `prettier` dependencies.

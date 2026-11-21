---
'@modern-js/app-tools-extensions': patch
'@modern-js/renderer-octane': patch
'@modern-js/ultramodern-create': patch
'@modern-js/ultramodern-sandpack-profile': patch
---

Upgrade the Effect-enabled compiler cohort to @effect/tsgo 0.73.2 and tsrs 7.1.0-beta.tsrs3 (embedded TypeScript 7.1.0-beta), and generated workspaces to Ultracite 8.3.1. The reviewed tsrs replacement targets are unchanged. tsrs versions now follow the `<embedded TypeScript version>.tsrs<build>` scheme, and compiler discovery accepts only that scheme.

Upstream tsrs 7.1.0-beta.tsrs3 still lacks the base-constraint identity correction (oxc-project/tsrs#996), so the owned compiler payload keeps the unchanged `constraint.patch` and is rebuilt from Effect-TS/tsgo ec0221e2 and tsrs eba9b2b7. The bounded tsrs trust exception moves to 7.1.0-beta.tsrs3.

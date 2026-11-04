---
'@modern-js/app-tools-extensions': patch
'@modern-js/ultramodern-create': patch
'@modern-js/ultramodern-sandpack-profile': patch
---

Upgrade the Effect-enabled compiler cohort to tsrs 0.21.0-ts7.1.0-beta and @effect/tsgo 0.67.0 while retaining stable TypeScript 7.0.2. The reviewed tsrs replacement targets are unchanged; @effect/tsgo 0.67.0 adds `effect-tsgo --tsrs-lint oxlint` for running Oxlint's type-aware rules on the Effect-patched tsrs.

Authenticate only the exact reviewed compiler releases during generator bootstrap, installation, and release auditing, carrying the bounded tsrs trust exception forward to 0.21.0-ts7.1.0-beta.

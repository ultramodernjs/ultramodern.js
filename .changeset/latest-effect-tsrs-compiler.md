---
'@modern-js/app-tools-extensions': patch
'@modern-js/ultramodern-create': patch
'@modern-js/ultramodern-sandpack-profile': patch
---

Upgrade the Effect-enabled compiler cohort to tsrs 0.20.1-ts7.1.0-beta and @effect/tsgo 0.63.0 while retaining stable TypeScript 7.0.2. Recognize the provider's Intel macOS and Windows x64 tsrs artifacts and default compiler launchers to locality scheduling.

Authenticate only the exact reviewed compiler and Effect 4.0.7 runtime release-age approvals during generator bootstrap, installation, and release auditing. Preserve no-downgrade trust with a bounded exception for the exact tsrs release, including source acceptance and continuation.

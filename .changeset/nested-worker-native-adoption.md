---
'@modern-js/renderer-octane': patch
'@modern-js/ultramodern-app-tools': patch
'@modern-js/ultramodern-create': patch
---

Use the accepted Octane runtime that retains equal-input nested publisher snapshots during initial hydration, preserving the server DOM and user input across lazy retries.

Keep the hydrated Worker publisher mounted during locale changes so host context and prop updates preserve its DOM, input and native state.

Capture generated file routes with their original host head callbacks while restoring only settled routing state in Workers, without replaying head callbacks.

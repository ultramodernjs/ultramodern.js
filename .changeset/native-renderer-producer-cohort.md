---
'@modern-js/renderer-octane': patch
'@modern-js/renderer-solid': patch
---

Generate and validate native renderer applications against the authenticated native producer cohort: Octane 0.18.0, `@octanejs/rspack-plugin` 0.2.10, `@octanejs/tanstack-router` 0.3.4 and `@tanstack/router-core` 1.171.39. Octane compiler manifests now carry the 0.18.0 runtime and 0.2.10 compiler ABI, and both renderers install the archives recorded in their `ultramodern.nativeArtifacts` descriptor.

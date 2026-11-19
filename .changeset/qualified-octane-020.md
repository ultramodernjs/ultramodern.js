---
'@modern-js/renderer-octane': patch
'@modern-js/renderer-solid': patch
'@modern-js/plugin-tanstack': patch
'@modern-js/ultramodern-app-tools': patch
'@modern-js/ultramodern-create': patch
---

Activate the hosted-qualified Octane 0.20.0 runtime, 0.3.6 router adapter and 0.2.12 Rspack plugin. Remove the obsolete 0.18 qualification path, keep the existing router Core bytes unchanged and align generated applications with the exact qualified archives.

Include the compiler-qualified CSSProperties declaration correction so React and Octane can resolve different csstype versions without conflicting inherited properties.

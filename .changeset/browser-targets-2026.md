---
'@modern-js/builder': minor
'@modern-js/create': minor
'@modern-js/ultramodern-create': minor
'@modern-js/ultramodern-sandpack-profile': minor
---

Raise the default browser targets to Chrome 144+, Edge 144+, Firefox 147+ and Safari 27+. This drops default support for older browsers. Explicit `output.overrideBrowserslist`, `.browserslistrc` and package.json Browserslist settings still take precedence.

Generated workspaces now let the builder set Autoprefixer's browser targets instead of overriding them with `defaults`. The Sandpack starter uses the same 2026 targets.

The basic app starter emits the same targets in its `.browserslistrc` file.

Update Browserslist and the locked browser compatibility data so Safari 27 is not silently omitted from the resolved targets.

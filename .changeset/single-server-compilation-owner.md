---
'@modern-js/app-tools': patch
'@modern-js/app-tools-extensions': patch
'@modern-js/plugin-bff': patch
'@modern-js/plugin-bff-build-extensions': patch
'@modern-js/server-utils': patch
---

Compile server and BFF sources with one build owner, discover their local dependency closure before emission, and finalize exactly the emitted JavaScript files, including dependencies reached through aliases.

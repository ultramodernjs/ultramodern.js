---
'@modern-js/app-tools-extensions': patch
'@modern-js/ultramodern-create': patch
---

Run the build type checker under the same tsrs profile as `ultramodern typecheck`. tsrs treats tsbuildinfo written under another profile as missing, so every app build rebuilt the shared references prepared by the typecheck. When app builds ran in parallel, one rewrote shared declarations in place while another read them, which failed with TS2306 "is not a module".

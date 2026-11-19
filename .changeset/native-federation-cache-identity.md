---
'@modern-js/ultramodern-app-tools': patch
---

Invalidate persistent compilation caches when native Module Federation is enabled or disabled. Switching between server-rendered and client-only applications no longer restores shared dependencies without their federation factories, while unchanged configurations retain warm cache restores.

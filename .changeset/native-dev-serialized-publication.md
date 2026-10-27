---
'@modern-js/ultramodern-app-tools': patch
---

Serialize native development publications so overlapping client and server compilation callbacks cannot clear CommonJS cache entries during another server import. Queued publications check their compilation epoch before running, and shutdown waits for publication to finish before removing its manifest.

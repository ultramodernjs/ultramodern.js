---
'@modern-js/renderer-core': patch
'@modern-js/renderer-solid': patch
'@modern-js/renderer-octane': patch
---

Release an entry-owned browser router when startup fails or HMR replaces the entry, removing its listeners and restoring browser history methods before the next entry starts.

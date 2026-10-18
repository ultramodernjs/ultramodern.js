---
'@modern-js/renderer-octane': patch
---

Keep Worker federation provider ranges consistent between server rendering and browser activation when only the browser has a Module Federation loader. Delayed remote activation adopts the original server elements and preserves typed input instead of mounting a second subtree.

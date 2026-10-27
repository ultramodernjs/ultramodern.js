---
'@modern-js/ultramodern-create': patch
---

Keep the accepted Node installation's npm on PATH during Tractor's registry
cohort verification, so mise cannot select an older npm and prevent downstream
Node and workerd acceptance from running.

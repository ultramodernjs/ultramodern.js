---
'@modern-js/renderer-solid': patch
---

Fail the owning Solid 2 request before rejecting unsupported application-router context overrides, so catching the rejection cannot commit a document. The rejection still avoids reading private context getters or changing native router options.

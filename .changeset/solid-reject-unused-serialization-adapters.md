---
'@modern-js/renderer-solid': patch
---

Remove unsupported custom serialization adapters from the Solid 2 router API. Reject JavaScript adapter options before document commitment and fail the owning request even when application code catches the error. Managed route data continues to use immutable public values and native promise serialization.

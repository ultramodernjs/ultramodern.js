---
'@modern-js/renderer-octane': patch
---

Use owning-qualified Octane CSS declarations that keep React's overlapping properties authoritative and preserve Octane's widened viewTransitionScope. Different csstype copies no longer produce conflicting inherited-property errors.

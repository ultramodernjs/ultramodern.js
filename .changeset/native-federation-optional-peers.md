---
'@modern-js/federation-runtime': patch
---

Declare the React providers used by the distributed SSR export as optional package peers so native renderer applications can install the shared SDK without React. Applications selecting React continue to require their selected runtime and hydration providers.

Depend directly on the published `@bleedingdev/mf-sdk@2.9.2` alias so installed consumers receive the qualified fork SDK without a workspace patch.

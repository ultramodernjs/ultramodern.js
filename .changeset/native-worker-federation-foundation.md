---
"@modern-js/renderer-core": patch
"@modern-js/federation-runtime": patch
"@modern-js/renderer-solid": patch
---

Add request-owned Worker federation admission, service transport and snapshot handling with bounded bodies, cancellation and native request cleanup.

Capture a federated module and its admitted browser assets under the same development-load lease so another host or revision cannot substitute newer assets.

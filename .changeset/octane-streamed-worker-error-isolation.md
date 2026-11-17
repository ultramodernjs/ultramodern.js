---
'@modern-js/renderer-octane': patch
'@modern-js/renderer-solid': patch
'@modern-js/plugin-tanstack': patch
'@modern-js/ultramodern-app-tools': patch
'@modern-js/ultramodern-create': patch
---

Select the authenticated native renderer cohort with corrected Octane streamed Suspense error isolation. After a remote's fallback has streamed, its failure keeps that fallback and allows healthy sibling remotes to finish instead of replacing the whole route. Errors before the shell still reach the route's error boundary.

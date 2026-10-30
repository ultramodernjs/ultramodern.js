---
"@modern-js/ultramodern-app-tools": patch
---

Install the reviewed Redact sidecar `@bleedingdev/tanstack-redact@0.2.2`. Its synthetic events keep non-enumerable Event fields such as `type`, `target` and `currentTarget`, so handlers and controlled inputs work in happy-dom test suites.

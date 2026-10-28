---
"@modern-js/ultramodern-app-tools": minor
"@modern-js/ultramodern-create": patch
---

Use framework-owned, patched TanStack Redact 0.2.1 as the default React runtime for client rendering, Node SSR and Cloudflare workerd SSR without application dependency or configuration changes. Keep real React for RSC applications and the explicit `redact: false` opt-out; expose `redact: { viewTransitions }` for experimental native View Transitions.

Classify Redact and its build plugin as React-owned dependencies during workspace validation, while preserving generated React/React DOM pins and the strict third-party release-age gate. Document the default runtime, streaming fixes and compatibility limits.

---
"@modern-js/server-runtime-extensions": patch
"@modern-js/app-tools-extensions": patch
---

Declare the telemetry middleware's HTTP response boundary explicitly so published declarations do not reference another package's private Hono installation.

Re-export the public Effect BFF configuration types through the server configuration entrypoint so Cloudflare manifest declarations can name them without private dependency paths.

---
"@modern-js/plugin-tanstack": patch
"@modern-js/runtime": patch
"@modern-js/plugin": patch
---

Merge TanStack Router's native loader-promise serialization with completed SSR document streams on Node and worker runtimes. Keep the native hydration boundary in the body, preserve renderer script boundaries, and propagate cancellation through the response stream.

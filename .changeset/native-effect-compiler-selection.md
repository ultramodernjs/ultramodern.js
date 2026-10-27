---
"@modern-js/app-tools-extensions": patch
"@modern-js/ultramodern-app-tools": patch
---

Use the shared native compiler resolver for build and dev checks. Select the provider's bundled Effect-enabled tsrs on declared native targets without patching the installed tsrs binary, and report the Effect TypeScript-Go choice on targets tsrs does not support. Keep missing or invalid supported artifacts fatal.

Resolve the compiler from the application rather than a realpathed TypeScript package in pnpm's store.

Read resolved configs through the compiler's native API instead of tsrs's unsupported `--showConfig` flag.

Apply the caller's checker assignment, or the Go assignment default, to every checker subprocess without changing the parent environment. Preserve TypeScript and Effect diagnostics, compiler exit codes, and watch recovery cleanup. Validate explicit compiler paths while allowing reviewed custom binaries that match the installed compiler cohort.

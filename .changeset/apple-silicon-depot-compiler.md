---
'@modern-js/app-tools-extensions': minor
---

Drop Intel Mac compiler support and require native Apple Silicon M3 or newer
for supported macOS use. Ship four compiler targets instead of five, reject
Intel/Rosetta compiler selection, and build release compilers on Depot while
preserving the Linux glibc baseline.

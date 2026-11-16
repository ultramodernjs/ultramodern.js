---
'@modern-js/app-tools-extensions': minor
---

Drop Intel Mac compiler support and require native Apple Silicon M3 or newer
for supported macOS use. Ship four compiler targets instead of five, reject
Intel/Rosetta compiler selection, and build release compilers on Depot Ubuntu
24.04. The Linux glibc baseline rises from 2.35 to 2.39, so the Linux compiler
binaries no longer run on Ubuntu 22.04 or older equivalents.

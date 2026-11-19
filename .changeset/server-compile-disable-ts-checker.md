---
'@modern-js/app-tools': patch
'@modern-js/app-tools-extensions': patch
'@modern-js/plugin-bff': patch
---

Honor `output.disableTsChecker` in server-only and BFF builds. Apps with a separate type check can opt out of build-time checking without losing JavaScript or declaration output. Type errors still fail server builds by default.

---
'@modern-js/app-tools-extensions': patch
---

Support opt-in backend federation container minification through an app's `package.json` setting `modernjs.backendFederation.containerMinify: "whitespace-syntax"`. Minify syntax and whitespace while preserving function/class names and identifiers. Omit the option to retain the existing output; unsupported explicit values fail at the app manifest boundary.

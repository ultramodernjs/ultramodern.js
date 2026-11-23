---
'@modern-js/plugin': patch
---

Evaluate installed JavaScript ESM configuration dependencies natively so optional `import.meta` properties work in the CJS CLI. Preserve CJS export identity and callable properties, local JavaScript and TypeScript configuration reloads, and the existing ESM CLI and dynamic-import behavior.

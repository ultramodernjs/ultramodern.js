---
"@modern-js/renderer-octane": patch
"@modern-js/runtime-utils": patch
"@modern-js/utils": patch
"@modern-js/ultramodern-create": patch
---

Raise the Happy DOM test dependency floor to 21.0.4 for GHSA-834v-8h66-3h79.

Update the workspace's same-major security overrides to DOMPurify 3.4.17,
body-parser 2.4.0, Undici 7.30.1 and Undici 8.12.2. These fix
GHSA-cg2g-xh64-v4q7, GHSA-mrv2-3pqr-j5jr, GHSA-27r3-jxmh-p828 and
GHSA-xjj6-f33q-929c without replacing existing API or native package patches.

Apply the same vulnerable-edge overrides in generated workspaces, whose
published dependencies do not inherit repository overrides.

All five fixed releases are older than 24 hours. Remove the obsolete Happy DOM
21.0.3 release-age exception without adding exceptions or relaxing the
1440-minute minimum and missing-timestamp policy.

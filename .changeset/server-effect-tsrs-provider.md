---
"@modern-js/server-utils": patch
"@modern-js/app-tools": patch
"@modern-js/plugin-bff": patch
"@modern-js/app-tools-extensions": patch
"@modern-js/ultramodern-app-tools": patch
"@modern-js/render": patch
"@modern-js/mcp-apps": patch
"@modern-js/ultramodern-create": patch
---

Use the app's verified Effect tsrs compiler for UltraModern server configuration, type checks, and declaration output. Keep vanilla server compilation unchanged and route remaining direct repository type checks through the existing compiler launcher.

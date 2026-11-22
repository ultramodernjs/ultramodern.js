---
'@modern-js/ultramodern-create': patch
'@modern-js/app-tools-extensions': patch
---

Run optional-property, successful-return and repeated-array-membership checks
against real configured compiler projects. Generated workspaces run this
semantic pass alongside Oxlint without depending on vendor forks.
Include emitted application build configurations in their owning compiler
projects instead of analyzing them with inferred options.
Keep public server compiler options on their owning Rsbuild and declaration
plugin types rather than exposing Rslib's implementation declaration graph.

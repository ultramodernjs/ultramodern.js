---
'@modern-js/ultramodern-create': patch
---

Run the installed typecheck with the tsrs fast preset and, in build mode, `--checkers` set to the core count minus 2, from 4 to 8. On a 27-project workspace this cut check time by about 20% at about the same peak memory, with identical diagnostics.

Projects change these defaults in the workspace root `package.json` under `ultramodern.typecheck` (`fast`, `checkers`, `builders`). `TSRS_FAST`, `ULTRAMODERN_TYPECHECK_CHECKERS` and `ULTRAMODERN_TYPECHECK_BUILDERS` override the file for one run, and `--checkers`, `--builders` or `--singleThreaded` passed to the command override both. Invalid settings fail before the compiler starts.

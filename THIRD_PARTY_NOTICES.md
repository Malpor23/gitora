# Third-party notices

Gitora is released under the MIT License (see [LICENSE](LICENSE)). It includes or
redistributes the third-party software below, each under its own license. This list
covers what ships inside the application; development-only tooling (Vitest, Prettier,
Playwright, electron-builder, etc.) is not redistributed.

| Component | License | Notes |
| --- | --- | --- |
| Angular (`@angular/*`) | MIT | Copyright Google LLC |
| RxJS | Apache-2.0 | Copyright Netflix, Inc., Microsoft Corp. and contributors |
| tslib | 0BSD | Copyright Microsoft Corporation |
| Tailwind CSS | MIT | Compiled into the stylesheet |
| IBM Plex Sans, IBM Plex Mono (`@fontsource/*`) | SIL OFL 1.1 | Copyright IBM Corp. Full text in [licenses/IBM-Plex-OFL-1.1.txt](licenses/IBM-Plex-OFL-1.1.txt) |
| Electron | MIT | Copyright OpenJS Foundation and Electron contributors. Packaged builds include `LICENSE.electron.txt` |
| Chromium and its dependencies (inside Electron) | Various (BSD-3-Clause, MIT, LGPL, etc.) | Packaged builds include `LICENSES.chromium.html` with the full list |

## Transitive dependencies

The full production tree (`npm ls --omit=dev --all`, reviewed 12 Nov 2026) adds only
`@standard-schema/spec` (MIT, type definitions used by `@angular/forms`) and `zod` (MIT,
Colin McDonnell) on top of the table above. Neither appears in the compiled `dist/`
output. All other packages in the tree are listed above. No GPL, AGPL or other
copyleft license is present in the production tree.

## Git

Gitora does **not** bundle Git. It runs the `git` executable already installed on the
user's system as a separate process. Git is licensed under GPL-2.0-only; that license
applies to Git itself, not to Gitora.

## Fonts

IBM Plex is distributed under the SIL Open Font License 1.1 and is not modified. It is
not sold on its own. The Reserved Font Names are not used for any modified version.

## How this list was produced

Licenses were read from each package's `package.json` and `LICENSE` file in
`node_modules`. Re-check this file whenever a runtime dependency is added or updated
(`npm ls --omit=dev` shows the production tree).

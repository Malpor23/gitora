# Code guide

## Conventions

- Strict TypeScript; avoid `any` (use `unknown`).
- Angular: standalone components (no explicit `standalone: true`), signals, `input()`/`output()`, `computed()`, native control flow (`@if`, `@for`), `inject()`. No `ngClass` or `ngStyle`. Host bindings in the `host` object.
- Forms: prefer Signal Forms for new ones; otherwise reactive forms.
- Accessibility: AXE and WCAG AA. Every field with `<label for>` and `id`, or `aria-label`.
- Code, identifiers and interface text are in English in the source; the interface is translated through dictionaries (`es` is the source of truth); documentation is in Spanish with an English copy in `docs/en/`.
- Styles with Tailwind classes in templates; shared widgets (`.btn`, `.dialog*`, fields) live in `src/styles.css`.

## Backend map

| File | Responsibility |
|------|----------------|
| `electron/main.ts` | Window, menu, allowlisted IPC, terminal launch |
| `electron/git/git-runner.ts` | Runs git, logs and emits progress, readable errors |
| `electron/git/git-service.ts` | One function per git operation |
| `electron/git/git-flow.ts` | Git flow (status, init, start, deinit) |
| `electron/git/repo-insights.ts` | Statistics, sizes, benchmark |
| `electron/git/parsers/` | `status`, `log`, `refs`, `diff` |
| `electron/git/editor-helper.ts` | Non-interactive editor for rebase and messages |
| `electron/providers/` | Providers, OAuth, SSH keys, registry |
| `electron/settings-store.ts` | Settings and secrets |
| `electron/repo-watcher.ts` | File watcher |
| `electron/dev-server.ts` | HTTP server for browser mode |

## Adding a git command

1. Add the method to `GitOps` and its name to `GIT_OP_NAMES` in `shared/api.ts`.
2. Implement it in `electron/git/git-service.ts` (the compiler requires it to exist).
3. Create the flow (dialog and execution) in `src/app/features/actions/git-flows.service.ts`.
4. Register it in `commands.service.ts` so it shows up in the palette, with a shortcut if appropriate.
5. Add the text keys to `es.ts` and `en.ts`.
6. Write the test against a real repository in `electron/tests/`.

Rules when implementing:

- Pass arguments as an array, never as a string for a shell.
- If the operation touches a remote, use `remoteAuth` (or `auth(url)` in a clone) for authentication.
- If it could open an editor, pass `env: this.noEditorEnv`.
- Parsers are pure: test them with sample text.

## Adding a language

There are five: Spanish (default), English, Brazilian Portuguese, French and German.

1. Copy `src/app/core/i18n/locales/en.ts` as `it.ts` (for example) and translate it. It is typed against Spanish: a missing key does not compile. Keep the `{{n}}` placeholders, the `...One` variants and the Git terms Spanish leaves in English.
2. Register it in `DICTS`, `LANGUAGES` and `LOCALES` (the region used for dates and numbers) in `src/app/core/i18n/i18n.ts` and add the code to the `Language` type (`src/app/core/models/setting.ts`).
3. Register it in `DICTS` of `electron/app-menu.ts` too: the native menu reads the `menu` section of the dictionary, but the main process has its own map.
4. `src/app/core/i18n/i18n.spec.ts` checks that every dictionary has the same keys and the same `{{...}}` placeholders; add the new language to that test and to the list of codes. With more than two languages the footer button cycles through all of them (`nextLanguage`).
5. The Windows installer (`installerLanguages` in `electron-builder.yml`) is only in Spanish and English: it is independent of the app interface.

## Adding a provider

1. Create `electron/providers/<name>.provider.ts` implementing `GitProvider`.
2. Register it in `ProviderRegistry` and in `normalizeApi`, `hostFromApi` and `guessProvider`.
3. Declare its authentication methods in `shared/auth.ts` (the single table used by backend and UI).
4. Add the type to `ProviderKind` in the models and an icon in `features/remote/provider-mark`.

## Tests

| Command | What it runs |
|---------|--------------|
| `npm run test:core` | Compiles `electron/` and runs `dist/electron/tests/*.test.js` with `node --test`. They use real git repositories in temporary folders |
| `npm test` | Component and logic tests of the renderer (`*.spec.ts`) |
| `npm run test:e2e` | Opens Gitora (real Electron) on a throwaway repository with a local remote and runs every toolbar dropdown item, checking the result with git (`e2e/`). Needs a display; CI uses `xvfb-run`. With `GITORA_E2E_REMOTE_URL=<url>` it also runs `e2e/remote.test.ts` against a real remote: it covers commit, push, fetch, pull (merge and rebase), force push, tags (create, push, delete local and remote, checkout) and rebase (onto a branch, autostash, interactive with drop/squash/reword, conflicts with abort/continue/skip). It only uses a new `gitora-e2e/<stamp>` branch and `gitora-e2e-*` tags, and deletes them at the end |

Guidelines: each test checks the observable effect (output, exit code, persisted data) through the public interface; temporary state goes in `mktemp -d` or `os.tmpdir()`, never inside the repo.

## Errors

`GitError` keeps `args`, `exitCode`, `stderr` and `stdout`. `friendlyError` extracts the `fatal:` or `error:` line to show to the user. Provider errors are `ProviderHttpError` with `status`.

## Adding a toolbar dropdown

1. Make sure the command exists in `Commands` (`features/actions/commands.service.ts`) with its `label`, `icon` and `shortcut`.
2. Add its id to the button's list in `TOOLBAR_MENUS` (`src/app/app.ts`). `'-'` inserts a separator and `'#i18n.key'` a section title.
3. In `app.html` the button calls `openToolbarMenu($event, '<key>')`. The menu is anchored to the button with `ContextMenuService.openAt`.

Commands whose `when` is not met are skipped automatically, and a title with no items below it is not shown.

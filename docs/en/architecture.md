# Architecture

Gitora is an Electron application with two processes that share a typed contract.

```
┌────────────────────────── Renderer (Angular 22) ──────────────────────────┐
│ features/*  ->  services (BridgeService, WorkspaceService, DialogService)  │
│                      │ window.gitora.git(op, ...args) / .app(op, ...)      │
└──────────────────────┼─────────────────────────────────────────────────────┘
                       │ preload.ts (contextBridge, no Node access)
┌──────────────────────┼──── Main process (Node) ────────────────────────────┐
│ main.ts: allowlisted IPC (GIT_OP_NAMES / APP_OP_NAMES)                     │
│   GitService  ->  GitRunner  ->  spawn("git", args)  (no shell)            │
│   ProviderRegistry -> GitHub / GitLab / Bitbucket / Gitea (HTTP fetch)     │
│   SettingsStore (JSON + secrets with safeStorage)   RepoWatcher            │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Top-level folders

| Folder | Role |
|--------|------|
| `shared/` | Contract between processes: `api.ts` (`GitOps`, `AppOps` interfaces, allowlists), `auth.ts` (authentication methods per provider), `patch.ts` (hunk and line patches) |
| `electron/` | Main process: `main.ts`, `preload.ts`, `git/`, `providers/`, `settings-store.ts`, `repo-watcher.ts`, `app-menu.ts`, `dev-server.ts`, `tests/` |
| `src/app/` | Angular renderer |
| `dist/` | Build output (`dist/renderer`, `dist/electron`, `dist/shared`) |
| `packaging/` | `PKGBUILD` and `.desktop` for Arch |

## IPC contract

`shared/api.ts` defines every operation as a TypeScript interface. `GIT_OP_NAMES` and `APP_OP_NAMES` are the allowlists. In `main.ts`, `registerIpc()` registers two channels:

- `gitora:git`: calls a `GitService` method.
- `gitora:app`: calls an application operation (settings, accounts, native dialogs, terminal).

Every call validates (1) that the sender is the main window and (2) that the name is on the allowlist. Errors are serialized (`serializeError`) and the renderer receives them as `Error`.

The renderer always calls through `BridgeService`, which uses `window.gitora` (preload in Electron, `http-bridge.ts` in browser mode). Main process events (command log, progress, repository changes, window focus) arrive through `gitora:event:<name>`.

## Main process

### GitRunner (`electron/git/git-runner.ts`)

The only place that runs `git`. It uses `spawn` without a shell, so arguments are never interpreted as commands. It sets stable global options (`core.quotepath=false`, `color.ui=false`, `core.pager=cat`), `GIT_TERMINAL_PROMPT=0` and `LANG=en_US.UTF-8` (English messages so they can be parsed). Every run is logged and emitted to the console; progress (`--progress`) is parsed from stderr.

### GitService (`electron/git/git-service.ts`)

One function per operation. Principles:

- Parsers (`electron/git/parsers/`) are pure functions over text: status v2, log, refs, diff.
- Authentication is injected with `-c` (see below) and never written to the repository configuration.
- Operations that could open an editor use `noEditorEnv` (`GIT_EDITOR` and `GIT_SEQUENCE_EDITOR` point to the helper).
- `rebaseInteractive` writes the todo built in the UI and the helper (`editor-helper.ts`) copies it as `GIT_SEQUENCE_EDITOR`; for `reword` and `squash` it supplies the queued messages.

### Providers (`electron/providers/`)

Each provider implements `GitProvider` (`provider.ts`): profile, repository listing, pull requests and Basic credentials for HTTPS. `ProviderRegistry` orchestrates them:

- Accounts are added by token, password, SSH key or OAuth device flow (`oauth.ts`).
- `normalizeApi` derives the API URL (for `github.com`, `gitlab.com` and `bitbucket.org` it always sets it).
- `authConfigFor(url)` returns the `-c` configuration for git:
  - HTTPS: `http.<scheme>//<host>/.extraHeader=Authorization: Basic ...`, limited to that host.
  - SSH: `core.sshCommand` with the key of that server's account.
- Expired OAuth tokens are refreshed with a single in-flight request per account.

### SettingsStore

Settings and accounts as JSON under the application data directory. Secrets (tokens, passwords) are encrypted with `safeStorage` (DPAPI on Windows, libsecret or KWallet on Linux) and are never sent to the renderer.

### RepoWatcher

Watches the working directory to refresh automatically. It is optional; when disabled, Gitora refreshes when the window regains focus.

## Renderer

Angular 22 with standalone components, signals and zoneless change detection. Styles with Tailwind v4 (tokens in `src/styles.css`).

| Layer | Path | Contents |
|-------|------|----------|
| Core | `src/app/core/` | `services/` (bridge, per-repo state, dialogs, menus, notices), `i18n/`, `models/`, `graph.ts` (graph lanes) |
| Features | `src/app/features/` | One folder per area: `history`, `changes`, `diff-viewer`, `sidebar`, `remote`, `settings`, `dialogs`, `command-palette`, `console-panel`, `welcome`, `actions` |
| Layout | `src/app/layout/` | Dialog and context menu host |
| Shared | `src/app/shared/` | Reusable components (icons, etc.) |

Import aliases: `@core/*`, `@features/*`, `@layout/*`, `@shared/*`.

`features/actions` holds the **flows** (`git-flows.service.ts`: dialog, validation and execution of each command) and the **command catalog** (`commands.service.ts`), which feeds the palette, the shortcuts and the toolbar dropdowns.

## Security

- `sandbox`, `contextIsolation` and no `nodeIntegration` in the renderer.
- Allowlisted IPC with sender verification.
- git through `spawn` without a shell.
- Strict CSP; external links open in the system browser.
- Authentication headers limited to the account's host.
- Secrets encrypted with the system keyring.
- The development server (browser mode) listens only on `127.0.0.1` and rejects foreign `Host` or `Origin`; it is not packaged.

## Flow of an operation: `clone` example

1. `welcome` opens a dialog (`git-flows.service.ts`) and calls `bridge.git('clone', ...)`.
2. The preload sends `gitora:git` with `op = 'clone'`.
3. `main.ts` validates sender and name, and calls `GitService.clone`.
4. `clone` asks `ProviderRegistry` for `auth(url)`, which returns the `-c` header if there is an account for that host.
5. `GitRunner.run` launches `git clone --progress` and emits progress events to the renderer.
6. When it finishes, `open()` resolves the repository root and the renderer opens the tab.

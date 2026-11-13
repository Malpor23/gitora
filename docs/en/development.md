# Development

## Requirements

Node.js 20 or higher, npm, git 2.30 or higher.

```bash
npm install
```

## Scripts

| Script | Action |
|--------|--------|
| `npm start` | Compiles `electron/`, starts `ng serve` on port 4300 and opens Electron (`GITORA_DEV=1`) |
| `npm run start:web` | Interface in the browser (`http://localhost:4300`) with real git |
| `npm test` | Renderer component and logic tests |
| `npm run build` | Angular and main process build |
| `npm run build:electron` | Only `tsc -p tsconfig.electron.json` |
| `npm run test:core` | Core tests against real repositories |
| `GITORA_E2E_PR_REPO_URL=<url> GITORA_E2E_GITHUB_TOKEN=<token> npm run test:e2e` | Also runs `e2e/pull-requests.test.ts` against real GitHub: adds a token account, creates PRs (normal, draft and with an invalid target), lists them, checks one out and closes them at the end. The token (`repo` scope, e.g. `$(gh auth token)`) only lives in a temporary profile and is never printed |
| `npm run launcher:install` / `launcher:uninstall` | Development desktop launcher with icon (Linux only) |
| `npm run test:e2e` | End-to-end test in real Electron: toolbar (`toolbar`), changes and diff (`changes`), sidebar and history (`sidebar-history`), and shell, settings, palette and shortcuts (`app-shell`), about 600 cases in total, takes about 20 minutes (needs a display; on headless Linux, `xvfb-run -a npm run test:e2e`). To test against a real remote: `GITORA_E2E_REMOTE_URL=git@gitlab.com:user/repo.git npm run test:e2e` (uses your credentials; only touches the `gitora-e2e/*` branch and `gitora-e2e-*` tags it creates and deletes). Over HTTPS with your `gh` session, without touching your global configuration: `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0='credential.https://github.com.helper' GIT_CONFIG_VALUE_0='!gh auth git-credential'`. If the remote is empty, GitHub makes the first pushed branch the default branch and does not allow deleting it: the test warns about it and that branch must be deleted by hand |
| `npm run dist:linux` / `dist:arch` / `dist:win` / `dist:mac` | Installers in `release/` |

After changing code in `electron/`, run `npm start` again (or `npm run build:electron`): Electron loads `dist/electron`, not the `.ts` files.

## Browser mode

`npm run start:web` starts `ng serve` (4300, with an `/api` proxy) and `electron/dev-server.ts` (127.0.0.1:4301), which reuses `GitService` and exposes its operations over HTTP. In the browser, `src/app/core/dev/http-bridge.ts` installs an HTTP `window.gitora` in development only.

- Data is kept separate, in `~/.config/gitora-dev` (change it with `GITORA_DEV_DATA`).
- Native dialogs are replaced by an in-app modal (`core/dev/path-picker/`).
- There is no `safeStorage` outside Electron: token accounts and the external terminal are not available.

## Screenshots

The images in `docs/img/` (Spanish) and `docs/en/img/` (English) were taken in browser mode, with headless Chromium driven by Playwright, on a sample repository (`main` and `feature/login` branches, a merge, a tag, and modified files). To repeat them:

1. `npm run start:web`.
2. Create a repository with that content in a temporary folder.
3. Set the language in the browser-mode settings (`es` or `en`), open `http://localhost:4300` at 1360x820, open the repository with `Ctrl+O` and capture each screen (changes, diff, history, palette, settings, console, the Branch dropdown).

### Accessibility

`e2e/a11y.test.ts` runs `axe-core` (WCAG 2.0, 2.1 and 2.2 level A and AA rules) over the history, Changes, the palette, Settings with all its tabs and the context menu, and checks the keyboard on the lists and tabs. `axe-core` (MPL-2.0) is only a development dependency and does not ship in the app. Run it with `xvfb-run -a node --test dist/e2e/a11y.test.js` after `npm run build` and `npx tsc -p tsconfig.e2e.json`. When you add new screens or dialogs, add them to that test.

## Building installers

```bash
npm run dist:linux     # AppImage, .pacman, .deb, .rpm, .tar.gz
npm run dist:arch      # .pacman only
npm run dist:win       # NSIS and portable; run on Windows
npm run dist:mac       # .dmg and .zip (x64 and arm64); run on macOS
```

Configuration is in `electron-builder.yml`. Runtime dependencies (`git`, `gtk3`, `nss`, `libsecret`...) are declared per format (`pacman`, `deb`, `rpm`).

Pushing a `v*` tag runs the Release workflow (`.github/workflows/release.yml`), which builds the Linux, Windows and macOS installers and attaches them to a GitHub release. The macOS job first runs `scripts/verify-macos.sh`, which mounts each `.dmg` and checks the Applications shortcut, the architecture, that the signature is valid and ad-hoc, and that the app starts (the last one only for the binary matching the runner architecture). If it fails, nothing is published. The workflow can also be launched by hand (`gh workflow run release.yml`): it builds and verifies without publishing, because the release is only created for a tag.

On macOS the signature is ad-hoc (`identity: "-"` and `hardenedRuntime: false` in `electron-builder.yml`): without it the `arm64` binaries do not start. Distributing without Gatekeeper warnings needs a Developer ID certificate and notarization (`CSC_LINK`, `CSC_KEY_PASSWORD` and `notarytool` credentials); that requires a paid Apple Developer account and is not configured.

## Icon and shortcuts

Icons live in `packaging/icons/` (PNG from 16 to 1024 and `gitora.svg`, generated from `public/icon.svg`). The packages (`pacman`, `deb`, `rpm`, AppImage and the `PKGBUILD`s) install them in `hicolor` along with `gitora.desktop`.

On Linux the window and panel icon does not come from `BrowserWindow.icon`: on Wayland the desktop reads it from the `.desktop` file whose name matches the `app_id` (here `gitora`), and on X11 from `StartupWMClass` (also `gitora`). An installed app ships that file; when run from source (`npm start`, E2E tests) there is none, which is why it shows no icon. To see it in development:

```bash
npm run launcher:install     # creates ~/.local/share/applications/gitora.desktop and the icons
npm run launcher:uninstall   # removes it
```

The development launcher is called "Gitora (dev)" and takes precedence over a system-installed one; remove it if you install the package.

## Publishing to the AUR

`packaging/aur/PKGBUILD` builds from the GitHub tag (`v<pkgver>`), so `yay -S gitora` or `paru -S gitora` work once the package is in the AUR. Gitora cannot publish it for you: it needs your AUR account.

1. Create an account at <https://aur.archlinux.org> and add your public SSH key to your profile.
2. Publish the tag and release on GitHub first (`git tag -a v0.1.1 -m v0.1.1 && git push origin v0.1.1`).
3. Clone the repository (it is created empty on the first push): `git clone ssh://aur@aur.archlinux.org/gitora.git aur-gitora`.
4. Copy `packaging/aur/PKGBUILD`, update the checksum with `updpkgsums` (`pacman-contrib` package) and generate the metadata: `makepkg --printsrcinfo > .SRCINFO`.
5. Test in a clean directory with `makepkg -si`.
6. `git add PKGBUILD .SRCINFO && git commit -m "gitora 0.1.1" && git push`.

For every new version: bump `pkgver`, repeat `updpkgsums` and `.SRCINFO`, and push. The build downloads the npm dependencies and the Electron binary, so it needs network access. For a quick install without compiling, you can also publish `gitora-bin`, reusing the release `.tar.gz`.

# Gitora

**English** | [Español](README.md)

Graphical Git client for Windows and Linux. It uses the `git` installed on your system, so your hooks, SSH keys, GPG and credential managers work exactly as they do in the terminal.

![Gitora](docs/img/changes.png)

Usage, architecture and code documentation lives in [`docs/`](docs/README.md) (Spanish).

## Requirements

- Git 2.30 or later on the `PATH`.
- To build from source: Node.js 20 or later and npm.
- Optional: `git-lfs` (Git LFS) and `openssh` (SSH remotes).

On Arch and derivatives: `sudo pacman -S git`.

## Download

Published installers are on [Releases](https://github.com/malpor23/gitora/releases). If your system has none, download the source and build the installer (see below).

```bash
git clone https://github.com/malpor23/gitora.git gitora
cd gitora
npm install
```

## Install

Build the installer with the command for your system. Files are written to the `release/` folder.

### Arch Linux and derivatives

```bash
npm run dist:arch
sudo pacman -U release/gitora-0.1.0.pacman
```

You can also use the bundled `PKGBUILD`:

```bash
cd packaging/arch
makepkg -si
```

### Other Linux distributions

```bash
npm run dist:linux
```

Produces `AppImage`, `.deb`, `.rpm` and `.tar.gz`. For the AppImage, make it executable and run it:

```bash
chmod +x release/Gitora-*.AppImage
./release/Gitora-*.AppImage
```

### Windows

Run on Windows (building it from Linux needs extra setup):

```bash
npm run dist:win
```

Produces an NSIS installer (Spanish and English) and a portable build in `release/`.

## Run without installing

```bash
npm start
```

Compiles the main process, starts Angular in dev mode and opens Electron. To try the UI in a browser, see [docs/desarrollo.md](docs/desarrollo.md).

## Getting started

1. Open the app and choose **Open local repository**, **Clone repository** or **Create new repository**.
2. To clone private repositories over HTTPS, add an account under **Settings, Accounts** (token, username and password, SSH key or OAuth).
3. Press `Ctrl+Shift+P` to list every available command.

Full guide: [docs/uso.md](docs/uso.md) (Spanish).

## Contributing and support

- Bugs and ideas: [Issues](https://github.com/malpor23/gitora/issues).
- Contributions: read [CONTRIBUTING.md](CONTRIBUTING.md) (Spanish) and open a pull request.
- Vulnerabilities: [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).

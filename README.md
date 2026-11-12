# Gitora

[English](README.en.md) | **Español**

Cliente Git gráfico para Windows, macOS y Linux. Usa el `git` instalado en tu sistema, así que tus hooks, llaves SSH, GPG y gestores de credenciales funcionan igual que en la terminal.

![Gitora](docs/img/changes.png)

La documentación de uso, arquitectura y código está en [`docs/`](docs/README.md) ([English](docs/en/README.md)).

## Requisitos

- Git 2.30 o superior en el `PATH`.
- Para compilar desde las fuentes: Node.js 20 o superior y npm.
- Opcional: `git-lfs` (Git LFS) y `openssh` (remotos por SSH).

En Arch y derivados: `sudo pacman -S git`.

## Descargar

Los instaladores publicados están en [Releases](https://github.com/malpor23/gitora/releases). Si tu sistema no tiene uno, descarga el código y genera el instalador (ver más abajo).

```bash
git clone https://github.com/malpor23/gitora.git gitora
cd gitora
npm install
```

## Instalar

Genera el instalador con el comando de tu sistema. Los archivos quedan en la carpeta `release/`.

### Arch Linux y derivados

Descarga el `.pacman` de [Releases](https://github.com/Malpor23/gitora/releases) e instálalo con `sudo pacman -U gitora-*.pacman`. Para compilar tú mismo:

```bash
npm run dist:arch
sudo pacman -U release/gitora-0.1.1.pacman
```

También puedes usar el `PKGBUILD` incluido:

```bash
cd packaging/arch
makepkg -si
```

### Otras distribuciones Linux

```bash
npm run dist:linux
```

Genera `AppImage`, `.deb`, `.rpm` y `.tar.gz`. Con el AppImage basta darle permiso de ejecución:

```bash
chmod +x release/Gitora-*.AppImage
./release/Gitora-*.AppImage
```

### Windows

Ejecuta en Windows (no se puede generar desde Linux sin configuración adicional):

```bash
npm run dist:win
```

Genera un instalador NSIS (español e inglés) y una versión portable en `release/`.

### macOS

Descarga el `.dmg` de [Releases](https://github.com/Malpor23/gitora/releases) (hay uno para Apple Silicon, `arm64`, y otro para Intel, `x64`), ábrelo y arrastra Gitora a Aplicaciones. Para compilar tú mismo, en un Mac:

```bash
npm run dist:mac
```

Genera un `.dmg` y un `.zip` por arquitectura en `release/`. Necesitas `git`: instala las herramientas de línea de comandos con `xcode-select --install` o usa Homebrew (`brew install git`).

La app **no está notarizada** (no hay cuenta de Apple Developer): va firmada de forma ad-hoc, así que macOS avisa la primera vez. Ábrela con clic derecho, **Abrir**, o quita la cuarentena:

```bash
xattr -dr com.apple.quarantine /Applications/Gitora.app
```

> Los instaladores de macOS se generan en CI y no se han probado en un Mac real.

## Ejecutar sin instalar

```bash
npm start
```

Compila el proceso principal, levanta Angular en modo desarrollo y abre Electron. Para probar la interfaz en el navegador, ver [docs/desarrollo.md](docs/desarrollo.md).

## Primeros pasos

1. Abre la aplicación y elige **Abrir repositorio local**, **Clonar repositorio** o **Crear repositorio nuevo**.
2. Para clonar repos privados por HTTPS agrega una cuenta en **Ajustes, Cuentas** (token, usuario y contraseña, clave SSH u OAuth).
3. Pulsa `Ctrl+Shift+P` para ver todos los comandos disponibles.

Guía completa: [docs/uso.md](docs/uso.md).

## Contribuir y soporte

- Errores y propuestas: [Issues](https://github.com/malpor23/gitora/issues).
- Aportes: lee [CONTRIBUTING.md](CONTRIBUTING.md) y abre un pull request.
- Vulnerabilidades: [SECURITY.md](SECURITY.md).

## Licencia

MIT. Ver [LICENSE](LICENSE), [avisos de terceros](THIRD_PARTY_NOTICES.md) y [aspectos legales](docs/legal.md).

Gitora es un proyecto independiente, sin afiliación con Git, GitHub, GitLab ni otras marcas mencionadas.

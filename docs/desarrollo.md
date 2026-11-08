# Desarrollo

## Requisitos

Node.js 20 o superior, npm, git 2.30 o superior.

```bash
npm install
```

## Scripts

| Script | Acción |
|--------|--------|
| `npm start` | Compila `electron/`, levanta `ng serve` en el puerto 4300 y abre Electron (`GITORA_DEV=1`) |
| `npm run start:web` | Interfaz en el navegador (`http://localhost:4300`) con git real |
| `npm run build` | Build de Angular y del proceso principal |
| `npm run build:electron` | Solo `tsc -p tsconfig.electron.json` |
| `npm run test:core` | Pruebas del núcleo contra repositorios reales |
| `npm run dist:linux` / `dist:arch` / `dist:win` | Instaladores en `release/` |

Tras cambiar código de `electron/`, vuelve a ejecutar `npm start` (o `npm run build:electron`): Electron carga `dist/electron`, no los `.ts`.

## Modo navegador

`npm run start:web` levanta `ng serve` (4300, con proxy de `/api`) y `electron/dev-server.ts` (127.0.0.1:4301), que reutiliza `GitService` y expone sus operaciones por HTTP. En el navegador, `src/app/core/dev/http-bridge.ts` instala un `window.gitora` HTTP solo en desarrollo.

- Los datos van aparte, en `~/.config/gitora-dev` (cambia con `GITORA_DEV_DATA`).
- Los diálogos nativos se reemplazan por un modal propio (`core/dev/path-picker/`).
- No hay `safeStorage` fuera de Electron: las cuentas con token y la terminal externa no están disponibles.

## Capturas de pantalla

Las imágenes de `docs/img/` se tomaron en modo navegador, con Chromium sin interfaz controlado por Playwright, sobre un repositorio de ejemplo (ramas `main` y `feature/login`, un merge, un tag y dos archivos modificados). Para repetirlas:

1. `npm run start:web`.
2. Crea un repositorio con ese contenido en una carpeta temporal.
3. Abre `http://localhost:4300` a 1360x820, abre el repositorio con `Ctrl+O` y captura cada pantalla (cambios, diff, historial, paleta, ajustes, consola).

## Compilar instaladores

```bash
npm run dist:linux     # AppImage, .pacman, .deb, .rpm, .tar.gz
npm run dist:arch      # solo .pacman
npm run dist:win       # NSIS y portable; ejecutar en Windows
```

La configuración está en `electron-builder.yml`. Las dependencias de ejecución (`git`, `gtk3`, `nss`, `libsecret`...) se declaran por formato (`pacman`, `deb`, `rpm`).

Antes de publicar, define `homepage` y `repository` en `package.json` y la `url` del `PKGBUILD`.

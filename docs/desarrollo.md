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
| `npm test` | Pruebas de componentes y lógica del renderer |
| `npm run build` | Build de Angular y del proceso principal |
| `npm run build:electron` | Solo `tsc -p tsconfig.electron.json` |
| `npm run test:core` | Pruebas del núcleo contra repositorios reales |
| `GITORA_E2E_PR_REPO_URL=<url> GITORA_E2E_GITHUB_TOKEN=<token> npm run test:e2e` | Además corre `e2e/pull-requests.test.ts` contra GitHub real: agrega una cuenta con token, crea PR (normal, borrador y con destino inválido), los lista, hace checkout y los cierra al terminar. El token (permiso `repo`, p. ej. `$(gh auth token)`) solo vive en un perfil temporal y nunca se imprime |
| `npm run launcher:install` / `launcher:uninstall` | Lanzador de escritorio de desarrollo con icono (solo Linux) |
| `npm run test:e2e` | Prueba de extremo a extremo en Electron real: barra de herramientas (`toolbar`), cambios y diff (`changes`), sidebar e historial (`sidebar-history`) y shell, ajustes, paleta y atajos (`app-shell`), unos 600 casos en total, tarda unos 20 minutos (necesita pantalla; en Linux sin escritorio, `xvfb-run -a npm run test:e2e`). Para probar contra un remoto real: `GITORA_E2E_REMOTE_URL=git@gitlab.com:usuario/repo.git npm run test:e2e` (usa tus credenciales; solo toca la rama `gitora-e2e/*` y los tags `gitora-e2e-*` que crea y borra). Por HTTPS con la sesión de `gh`, sin tocar tu configuración global: `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0='credential.https://github.com.helper' GIT_CONFIG_VALUE_0='!gh auth git-credential'`. Si el remoto está vacío, GitHub convierte la primera rama empujada en la rama por defecto y no deja borrarla: la prueba lo avisa y esa rama hay que borrarla a mano |
| `npm run dist:linux` / `dist:arch` / `dist:win` / `dist:mac` | Instaladores en `release/` |

Tras cambiar código de `electron/`, vuelve a ejecutar `npm start` (o `npm run build:electron`): Electron carga `dist/electron`, no los `.ts`.

## Modo navegador

`npm run start:web` levanta `ng serve` (4300, con proxy de `/api`) y `electron/dev-server.ts` (127.0.0.1:4301), que reutiliza `GitService` y expone sus operaciones por HTTP. En el navegador, `src/app/core/dev/http-bridge.ts` instala un `window.gitora` HTTP solo en desarrollo.

- Los datos van aparte, en `~/.config/gitora-dev` (cambia con `GITORA_DEV_DATA`).
- Los diálogos nativos se reemplazan por un modal propio (`core/dev/path-picker/`).
- No hay `safeStorage` fuera de Electron: las cuentas con token y la terminal externa no están disponibles.

## Capturas de pantalla

Las imágenes de `docs/img/` (español) y `docs/en/img/` (inglés) se tomaron en modo navegador, con Chromium sin interfaz controlado por Playwright, sobre un repositorio de ejemplo (ramas `main` y `feature/login`, un merge, un tag y dos archivos modificados). Para repetirlas:

1. `npm run start:web`.
2. Crea un repositorio con ese contenido en una carpeta temporal.
3. Abre `http://localhost:4300` a 1360x820, abre el repositorio con `Ctrl+O` y captura cada pantalla (cambios, diff, historial, paleta, ajustes, consola, el desplegable de Rama). Cambia el idioma en los ajustes del modo navegador (`es` o `en`) para cada juego de imágenes.

## Compilar instaladores

```bash
npm run dist:linux     # AppImage, .pacman, .deb, .rpm, .tar.gz
npm run dist:arch      # solo .pacman
npm run dist:win       # NSIS y portable; ejecutar en Windows
npm run dist:mac       # .dmg y .zip (x64 y arm64); ejecutar en macOS
```

La configuración está en `electron-builder.yml`. Las dependencias de ejecución (`git`, `gtk3`, `nss`, `libsecret`...) se declaran por formato (`pacman`, `deb`, `rpm`).

Al publicar un tag `v*` se ejecuta el workflow Release (`.github/workflows/release.yml`), que compila los instaladores de Linux, Windows y macOS y los adjunta a un release de GitHub.

En macOS la firma es ad-hoc (`identity: "-"` y `hardenedRuntime: false` en `electron-builder.yml`): sin ella los binarios `arm64` no arrancan. Para distribuir sin avisos de Gatekeeper hace falta un certificado Developer ID y notarización (variables `CSC_LINK`, `CSC_KEY_PASSWORD` y las credenciales de `notarytool`); eso requiere una cuenta de Apple Developer de pago y no está configurado.

## Icono y accesos directos

Los iconos están en `packaging/icons/` (PNG de 16 a 1024 y `gitora.svg`, generados desde `public/icon.svg`). Los paquetes (`pacman`, `deb`, `rpm`, AppImage y los `PKGBUILD`) los instalan en `hicolor` junto con `gitora.desktop`.

En Linux el icono de la ventana y del panel no sale de `BrowserWindow.icon`: en Wayland lo toma el entorno del archivo `.desktop` cuyo nombre coincide con el `app_id` (aquí `gitora`), y en X11 de `StartupWMClass` (también `gitora`). Una app instalada ya trae ese archivo; ejecutada desde el código fuente (`npm start`, pruebas E2E) no, y por eso aparece sin icono. Para verlo en desarrollo:

```bash
npm run launcher:install     # crea ~/.local/share/applications/gitora.desktop y los iconos
npm run launcher:uninstall   # lo elimina
```

El lanzador de desarrollo se llama «Gitora (dev)» y tiene prioridad sobre uno instalado por el sistema; elimínalo si instalas el paquete.

## Publicar en el AUR

`packaging/aur/PKGBUILD` compila desde el tag de GitHub (`v<pkgver>`), de modo que `yay -S gitora` o `paru -S gitora` funcionan cuando el paquete está en el AUR. Gitora no puede publicarlo por ti: requiere tu cuenta del AUR.

1. Crea una cuenta en <https://aur.archlinux.org> y agrega tu clave SSH pública en tu perfil.
2. Publica antes el tag y el release en GitHub (`git tag -a v0.1.0 -m v0.1.0 && git push origin v0.1.0`).
3. Clona el repositorio (se crea vacío en el primer push): `git clone ssh://aur@aur.archlinux.org/gitora.git aur-gitora`.
4. Copia `packaging/aur/PKGBUILD`, actualiza la suma con `updpkgsums` (paquete `pacman-contrib`) y genera los metadatos: `makepkg --printsrcinfo > .SRCINFO`.
5. Prueba en limpio con `makepkg -si`.
6. `git add PKGBUILD .SRCINFO && git commit -m "gitora 0.1.0" && git push`.

Para cada versión nueva: sube `pkgver`, repite `updpkgsums` y `.SRCINFO`, y haz push. El build descarga las dependencias de npm y el binario de Electron, así que necesita red. Si prefieres una instalación rápida sin compilar, se puede publicar además `gitora-bin`, que reutilice el `.tar.gz` del release.

# Arquitectura

Gitora es una aplicación Electron con dos procesos que comparten un contrato tipado.

```
┌────────────────────────── Renderer (Angular 22) ──────────────────────────┐
│ features/*  ->  services (BridgeService, WorkspaceService, DialogService)  │
│                      │ window.gitora.git(op, ...args) / .app(op, ...)      │
└──────────────────────┼─────────────────────────────────────────────────────┘
                       │ preload.ts (contextBridge, sin acceso a Node)
┌──────────────────────┼──── Proceso principal (Node) ───────────────────────┐
│ main.ts: IPC con lista blanca (GIT_OP_NAMES / APP_OP_NAMES)                │
│   GitService  ->  GitRunner  ->  spawn("git", args)  (sin shell)           │
│   ProviderRegistry -> GitHub / GitLab / Bitbucket / Gitea (fetch HTTP)     │
│   SettingsStore (JSON + secretos con safeStorage)   RepoWatcher            │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Carpetas de primer nivel

| Carpeta | Rol |
|---------|-----|
| `shared/` | Contrato entre procesos: `api.ts` (interfaces `GitOps`, `AppOps`, listas blancas), `auth.ts` (métodos de autenticación por proveedor), `patch.ts` (parches por hunk y línea) |
| `electron/` | Proceso principal: `main.ts`, `preload.ts`, `git/`, `providers/`, `settings-store.ts`, `repo-watcher.ts`, `app-menu.ts`, `dev-server.ts`, `tests/` |
| `src/app/` | Renderer Angular |
| `dist/` | Salida de compilación (`dist/renderer`, `dist/electron`, `dist/shared`) |
| `packaging/` | `PKGBUILD` y `.desktop` para Arch |

## Contrato IPC

`shared/api.ts` define todas las operaciones como interfaces TypeScript. `GIT_OP_NAMES` y `APP_OP_NAMES` son las listas blancas. En `main.ts`, `registerIpc()` registra dos canales:

- `gitora:git`: invoca un método de `GitService`.
- `gitora:app`: invoca un método de las operaciones de aplicación (ajustes, cuentas, diálogos nativos, terminal).

Cada llamada valida (1) que el emisor sea la ventana principal y (2) que el nombre esté en la lista blanca. Los errores se serializan (`serializeError`) y el renderer los recibe como `Error`.

El renderer llama siempre a través de `BridgeService`, que usa `window.gitora` (preload en Electron, `http-bridge.ts` en modo navegador). Los eventos del proceso principal (log de comandos, progreso, cambios en el repo, foco de ventana) llegan por `gitora:event:<nombre>`.

## Proceso principal

### GitRunner (`electron/git/git-runner.ts`)

Único punto que ejecuta `git`. Usa `spawn` sin shell, por lo que los argumentos nunca se interpretan como comandos. Fija opciones globales estables (`core.quotepath=false`, `color.ui=false`, `core.pager=cat`), `GIT_TERMINAL_PROMPT=0` y `LANG=en_US.UTF-8` (mensajes en inglés para poder interpretarlos). Cada ejecución se registra y se emite a la consola; el progreso (`--progress`) se parsea desde stderr.

### GitService (`electron/git/git-service.ts`)

Una función por operación. Principios:

- Los parsers (`electron/git/parsers/`) son funciones puras sobre texto: status v2, log, refs, diff.
- La autenticación se inyecta con `-c` (ver abajo), nunca se escribe en la configuración del repositorio.
- Las operaciones que podrían abrir un editor usan `noEditorEnv` (`GIT_EDITOR` y `GIT_SEQUENCE_EDITOR` apuntan al helper).
- `rebaseInteractive` escribe el todo armado en la UI y el helper (`editor-helper.ts`) lo copia como `GIT_SEQUENCE_EDITOR`; para `reword` y `squash` entrega los mensajes en cola.

### Proveedores (`electron/providers/`)

Cada proveedor implementa `GitProvider` (`provider.ts`): perfil, listado de repositorios, pull requests y credenciales Basic para HTTPS. `ProviderRegistry` los orquesta:

- Alta de cuentas por token, contraseña, clave SSH u OAuth device flow (`oauth.ts`).
- `normalizeApi` deduce la URL de la API (para `github.com`, `gitlab.com` y `bitbucket.org` siempre la fija).
- `authConfigFor(url)` devuelve la configuración `-c` para git:
  - HTTPS: `http.<esquema>//<host>/.extraHeader=Authorization: Basic ...`, limitada a ese host.
  - SSH: `core.sshCommand` con la clave de la cuenta de ese servidor.
- Los tokens OAuth vencidos se renuevan con una sola petición en vuelo por cuenta.

### SettingsStore

Ajustes y cuentas en JSON bajo el directorio de datos de la aplicación. Los secretos (tokens, contraseñas) se cifran con `safeStorage` (DPAPI en Windows, libsecret o KWallet en Linux) y nunca se envían al renderer.

### RepoWatcher

Observa el directorio de trabajo para refrescar automáticamente. Es opcional; si está desactivado, Gitora actualiza al volver a enfocar la ventana.

## Renderer

Angular 22 con componentes standalone, signals y detección de cambios sin zone. Estilos con Tailwind v4 (tokens en `src/styles.css`).

| Capa | Ruta | Contenido |
|------|------|-----------|
| Núcleo | `src/app/core/` | `services/` (puente, estado por repo, diálogos, menús, avisos), `i18n/`, `models/`, `graph.ts` (carriles del grafo) |
| Funcionalidades | `src/app/features/` | Una carpeta por área: `history`, `changes`, `diff-viewer`, `sidebar`, `remote`, `settings`, `dialogs`, `command-palette`, `console-panel`, `welcome`, `actions` |
| Layout | `src/app/layout/` | Contenedor de diálogos y menús contextuales |
| Compartido | `src/app/shared/` | Componentes reutilizables (iconos, etc.) |

Alias de importación: `@core/*`, `@features/*`, `@layout/*`, `@shared/*`.

`features/actions` concentra los **flujos** (`git-flows.service.ts`: diálogo, validación y ejecución de cada comando) y el **catálogo de comandos** (`commands.service.ts`), que alimenta la paleta y los atajos.

## Seguridad

- `sandbox`, `contextIsolation` y sin `nodeIntegration` en el renderer.
- IPC con lista blanca y verificación del emisor.
- git por `spawn` sin shell.
- CSP estricta; los enlaces externos se abren en el navegador del sistema.
- Cabeceras de autenticación limitadas al host de la cuenta.
- Secretos cifrados con el llavero del sistema.
- El servidor de desarrollo (modo navegador) escucha solo en `127.0.0.1` y rechaza `Host` u `Origin` ajenos; no se empaqueta.

## Flujo de una operación: ejemplo `clone`

1. `welcome` abre un diálogo (`git-flows.service.ts`) y llama `bridge.git('clone', ...)`.
2. El preload envía `gitora:git` con `op = 'clone'`.
3. `main.ts` valida emisor y nombre, y llama `GitService.clone`.
4. `clone` pide `auth(url)` al `ProviderRegistry`, que devuelve la cabecera `-c` si hay cuenta para ese host.
5. `GitRunner.run` lanza `git clone --progress` y emite eventos de progreso al renderer.
6. Al terminar, `open()` resuelve la raíz del repositorio y el renderer abre la pestaña.

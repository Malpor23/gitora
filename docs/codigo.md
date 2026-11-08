# Guía de código

## Convenciones

- TypeScript estricto; evitar `any` (usar `unknown`).
- Angular: componentes standalone (sin `standalone: true` explícito), signals, `input()`/`output()`, `computed()`, control flow nativo (`@if`, `@for`), `inject()`. Sin `ngClass` ni `ngStyle`. Host bindings en el objeto `host`.
- Formularios: preferir Signal Forms para nuevos; si no, reactivos.
- Accesibilidad: AXE y WCAG AA. Cada campo con `<label for>` y `id`, o `aria-label`.
- Código, identificadores y textos de interfaz en inglés dentro del código fuente; la interfaz se traduce por diccionarios (`es` es la fuente de verdad); la documentación va en español, con copia en inglés en `docs/en/`.
- Estilos con clases Tailwind en las plantillas; los widgets compartidos (`.btn`, `.dialog*`, campos) viven en `src/styles.css`.

## Mapa del backend

| Archivo | Responsabilidad |
|---------|-----------------|
| `electron/main.ts` | Ventana, menú, IPC con lista blanca, apertura de terminal |
| `electron/git/git-runner.ts` | Ejecuta git, registra y emite progreso, errores legibles |
| `electron/git/git-service.ts` | Una función por operación git |
| `electron/git/git-flow.ts` | Git flow (estado, init, start, deinit) |
| `electron/git/repo-insights.ts` | Estadísticas, tamaños, benchmark |
| `electron/git/parsers/` | `status`, `log`, `refs`, `diff` |
| `electron/git/editor-helper.ts` | Editor no interactivo para rebase y mensajes |
| `electron/providers/` | Proveedores, OAuth, claves SSH, registro |
| `electron/settings-store.ts` | Ajustes y secretos |
| `electron/repo-watcher.ts` | Observador de archivos |
| `electron/dev-server.ts` | Servidor HTTP para el modo navegador |

## Agregar un comando git

1. Añade el método a `GitOps` y su nombre a `GIT_OP_NAMES` en `shared/api.ts`.
2. Impleméntalo en `electron/git/git-service.ts` (el compilador exige que exista).
3. Crea el flujo (diálogo y ejecución) en `src/app/features/actions/git-flows.service.ts`.
4. Regístralo en `commands.service.ts` para que aparezca en la paleta, con atajo si corresponde.
5. Agrega las claves de texto en `es.ts` y `en.ts`.
6. Escribe la prueba contra un repositorio real en `electron/tests/`.

Reglas al implementar:

- Pasa los argumentos como arreglo, nunca como cadena para una shell.
- Si la operación toca un remoto, usa `remoteAuth` (o `auth(url)` en un clone) para la autenticación.
- Si podría abrir un editor, pasa `env: this.noEditorEnv`.
- Los parsers son puros: pruébalos con texto de ejemplo.

## Agregar un idioma

1. Copia `src/app/core/i18n/locales/en.ts` como `pt.ts` y tradúcelo. Está tipado contra el español: si falta una clave, no compila.
2. Regístralo en `DICTS` y `LANGUAGES` (`src/app/core/i18n/i18n.ts`) y agrega el código al tipo `Language` (`src/app/core/models/setting.ts`).
3. El menú nativo (`electron/app-menu.ts`) lee la sección `menu` del mismo diccionario, así que queda cubierto.

## Agregar un proveedor

1. Crea `electron/providers/<nombre>.provider.ts` implementando `GitProvider`.
2. Regístralo en `ProviderRegistry` y en `normalizeApi`, `hostFromApi` y `guessProvider`.
3. Declara sus métodos de autenticación en `shared/auth.ts` (tabla única que usan backend y UI).
4. Añade el tipo a `ProviderKind` en los modelos y un icono en `features/remote/provider-mark`.

## Pruebas

| Comando | Qué ejecuta |
|---------|-------------|
| `npm run test:core` | Compila `electron/` y ejecuta `dist/electron/tests/*.test.js` con `node --test`. Usan repositorios git reales en carpetas temporales |
| `ng test` | Pruebas de componentes y lógica del renderer (`*.spec.ts`) |
| `npm run test:e2e` | Abre Gitora (Electron real) sobre un repositorio desechable con remoto local y ejecuta cada ítem de los desplegables de la barra, verificando el resultado con git (`e2e/`). Necesita pantalla; en CI se usa `xvfb-run`. Con `GITORA_E2E_REMOTE_URL=<url>` corre además `e2e/remote.test.ts` contra un remoto real: cubre commit, push, fetch, pull (merge y rebase), force push, tags (crear, push, borrar local y remoto, checkout) y rebase (sobre una rama, autostash, interactivo con descartar/combinar/reword, conflictos con abortar/continuar/omitir). Solo usa una rama nueva `gitora-e2e/<marca>` y tags `gitora-e2e-*`, y los borra al terminar |

Pautas: cada prueba verifica el efecto observable (salida, código de salida, datos persistidos) por la interfaz pública; el estado temporal va en `mktemp -d` o `os.tmpdir()`, nunca dentro del repo.

## Errores

`GitError` conserva `args`, `exitCode`, `stderr` y `stdout`. `friendlyError` extrae la línea `fatal:` o `error:` para mostrar al usuario. Los errores de proveedores son `ProviderHttpError` con `status`.

## Agregar un desplegable a la barra de herramientas

1. Asegura que el comando exista en `Commands` (`features/actions/commands.service.ts`) con su `label`, `icon` y `shortcut`.
2. Agrega su id a la lista del botón en `TOOLBAR_MENUS` (`src/app/app.ts`). `'-'` inserta un separador y `'#clave.i18n'` un título de sección.
3. En `app.html` el botón llama a `openToolbarMenu($event, '<clave>')`. El menú se ancla al botón con `ContextMenuService.openAt`.

Los comandos con `when` que no se cumple se omiten solos, y un título sin ítems debajo no se muestra.

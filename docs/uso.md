# Guía de uso

## Pantalla de inicio

![Inicio](img/welcome.png)

- **Abrir repositorio local** (`Ctrl+O`): elige una carpeta que ya sea un repositorio git.
- **Clonar repositorio**: URL, carpeta destino, rama, profundidad (`--depth`), submódulos y `--bare`. Muestra el progreso del clone.
- **Clonar desde mi cuenta**: lista los repositorios de las cuentas configuradas (GitHub, GitLab, Bitbucket, Gitea).
- **Crear repositorio nuevo**: ejecuta `git init`, con rama inicial opcional.

![Clonar](img/clone.png)

Para repositorios privados por HTTPS, agrega antes una cuenta (ver [Cuentas](#cuentas)). Sin cuenta, git no puede pedir credenciales y el clone falla con un mensaje que lo indica.

## Cambios locales y commit

![Cambios](img/changes.png)

Panel central: archivos **sin preparar** y **preparados**. Se pueden preparar o quitar por archivo, por hunk y por línea (clic en las líneas `+`/`-` del diff, `Mayús` amplía la selección). Debajo, el formulario de commit: resumen, descripción, enmendar, firmar (`Signed-off-by`) y omitir hooks.

![Diff](img/diff.png)

El diff admite vista unificada y en paralelo. Desde aquí también se descartan hunks.

## Historial

![Historial](img/history.png)

Grafo de commits con carriles de color por rama, búsqueda por mensaje, autor o hash, filtro por rama, primer padre y carga progresiva. Al elegir un commit se ven sus detalles y archivos. Desde el menú contextual de un commit: cherry-pick, revert, reset, crear rama o tag, rebase interactivo.

## Barra de herramientas

Debajo de las pestañas están las acciones más usadas. Los botones con una flecha (chevron) abren un menú desplegable:

| Botón | Clic principal | Desplegable |
|-------|----------------|-------------|
| Fetch | Fetch rápido | Fetch (elegir remoto), Fetch all |
| Pull | Pull rápido | Pull con diálogo (remoto, rama, rebase, autostash) |
| Push | Push rápido | Push con diálogo, Force push, Push all tags |
| Branch | Nueva rama | Nuevo worktree, Git Flow (feature, release, hotfix, init, deinit), checkout, renombrar, eliminar |
| Rebase | Rebase | Rebase interactivo, cherry-pick, revert, reset, continuar, omitir, abortar |
| Pop | Aplicar el último stash | Guardar stash, pop, vaciar |
| Repository | (solo desplegable) | Refresh, nuevo tag, aplicar parche, bisect, reflog, estadísticas, treemap, benchmark, gc, archivo, identidad y configuración |

Las opciones que no aplican al estado actual (por ejemplo, continuar sin una operación en curso) no aparecen.

## Paleta de comandos

![Paleta](img/palette.png)

`Ctrl+Shift+P` lista todos los comandos git con su atajo. Es la forma más rápida de llegar a funciones menos frecuentes (bisect, worktrees, submódulos, LFS, `gc`, archivo, parches).

## Consola

![Consola](img/console.png)

`` Ctrl+` `` abre la consola. Cada comando que ejecuta Gitora queda registrado con su salida y duración. También puedes escribir comandos git propios (sin el prefijo `git`, o con él). Los comandos que abrirían un editor (por ejemplo `rebase -i`) usan un editor no interactivo que acepta el contenido por defecto; para armar el rebase usa el rebase interactivo visual.

## Ajustes

![Ajustes](img/settings.png)

Idioma (español o inglés, en vivo), tema (oscuro, claro, del sistema), tamaño de letra, confirmación en acciones peligrosas, vigilancia del directorio de trabajo, terminal preferida, y las pestañas Git, Diff, Cuentas y Acerca de.

## Cuentas

En **Ajustes, Cuentas** se agregan cuentas de GitHub (y Enterprise), GitLab (y propio), Bitbucket y Gitea/Forgejo/Codeberg. Métodos de autenticación, según el proveedor:

| Método | Uso |
|--------|-----|
| Token de acceso | HTTPS y API (clonar desde cuenta, pull requests) |
| Usuario y contraseña | HTTPS; en Bitbucket, App Password |
| Clave SSH | Remotos SSH de ese servidor, sin acceso a la API |
| OAuth (device flow) | GitHub y GitLab, con el Client ID de tu propia OAuth App |

Permisos de token recomendados:

- **GitHub:** `repo` (y `read:org` si usas organizaciones).
- **GitLab:** `api`, `read_repository`, `write_repository`.
- **Bitbucket:** usuario y App Password.
- **Gitea, Forgejo, Codeberg:** token de aplicación.

En el campo **Servidor** deja vacío para `github.com`, `gitlab.com` y `bitbucket.org`. Para servidores propios escribe el dominio (`gitlab.miempresa.com`); Gitora completa la ruta de la API.

Los secretos se cifran con el llavero del sistema y no llegan a la interfaz.

## Atajos de teclado

| Atajo | Acción |
|-------|--------|
| `Ctrl+Shift+P` | Paleta de comandos |
| `Ctrl+O` | Abrir repositorio |
| `F5` | Actualizar |
| `Ctrl+1` / `Ctrl+2` | Cambios locales / Historial |
| `Ctrl+Shift+F` / `L` / `K` | Fetch / Pull / Push |
| `Ctrl+Shift+B` | Crear rama |
| `Ctrl+Shift+O` | Cambiar de rama |
| `Ctrl+Shift+M` | Merge |
| `Ctrl+Shift+S` | Stash |
| `Ctrl+Shift+A` | Preparar todo |
| `Ctrl+Shift+G` | Comando git personalizado |
| `Ctrl+Enter` / `Ctrl+Shift+Enter` | Commit / Commit y push |
| `Ctrl+F` | Buscar commits |
| `` Ctrl+` `` | Consola |
| `Ctrl+,` | Ajustes |

## Funciones por área

| Área | Funciones |
|------|-----------|
| Repositorios | Abrir, clonar, crear, pestañas, recientes, terminal y explorador |
| Cambios | Stage por archivo, hunk y línea; descartar; ignorar; `clean` con vista previa |
| Commit | Resumen y descripción, enmendar, sign-off, omitir hooks, commit y push |
| Historial | Grafo, búsqueda, historial de archivo, blame |
| Ramas | Crear, checkout, renombrar, eliminar (local y remota), upstream |
| Integración | Merge (ff, no-ff, ff-only, squash), rebase, rebase interactivo visual, cherry-pick, revert, reset |
| Conflictos | Resolución por bloques, edición del resultado, `mergetool` externo |
| Remotos | Fetch, pull (merge, rebase, ff-only, autostash), push (upstream, tags, force-with-lease), administrar remotos |
| Tags y stash | Ligeros y anotados, push y borrado remoto; stash con opciones |
| Más | Submódulos, worktrees, bisect, reflog, `git config`, Git LFS, `gc`, `archive`, parches, git flow, estadísticas del repositorio |

# Comparativa con otros clientes

Revisión de Gitora frente a cuatro clientes, para detectar funciones que faltan.

**Fuentes y confianza.** De SourceGit se leyó la lista de funciones de su página oficial; de GitHub Desktop solo distribución y alcance (su página no lista funciones), por lo que sus celdas se basan en conocimiento general. La página de TortoiseGit no pudo leerse y la de git-cola solo muestra metadatos, así que esas columnas y las de GitHub Desktop deben confirmarse antes de decidir prioridades. La columna Gitora se verificó buscando en el código; "no encontrado" significa que no hay referencias, no que sea imposible agregarlo.

## Cobertura

| Función | Gitora | SourceGit | GitHub Desktop | TortoiseGit | git-cola |
|---------|:------:|:---------:|:--------------:|:-----------:|:--------:|
| Clone, fetch, pull, push | Sí | Sí | Sí | Sí | Sí |
| Merge, rebase, reset, revert, cherry-pick | Sí | Sí | Parcial | Sí | Sí |
| Rebase interactivo visual | Sí | Sí | No | Sí | Sí |
| Stage por hunk y línea | Sí | Sí | Sí | Sí | Sí |
| Grafo de commits, búsqueda | Sí | Sí | Lista simple | Sí | Sí (DAG) |
| Blame e historial de archivo | Sí | Sí | No | Sí | Sí |
| Ramas, remotos, tags, stash | Sí | Sí | Parcial | Sí | Sí |
| Submódulos, worktrees, bisect, LFS | Sí | Sí | No | Sí | Parcial |
| Git flow | Sí | Sí | No | No | No |
| Resolución visual de conflictos | Sí | Sí | Abre editor externo | Sí | Sí |
| Registro de comandos git | Sí | Sí | No | No | Parcial |
| Pull requests (crear y ver) | Sí | Crear | Crear | No | No |
| Varias cuentas y proveedores | Sí | Por remoto | GitHub | No | No |
| SSH por cuenta | Sí | Sí | No | Sí | No |
| Tema claro y oscuro | Sí | Sí, y personalizados | Sí | Sistema | Sí |
| Idiomas | 2 | 14 | Pocos | Muchos | Varios |
| Diff de imágenes | No encontrado | Sí | Sí | Sí | No |
| Mensaje de commit con IA | No | Sí | No | No | No |
| Ayuda para commits convencionales | No encontrado | Sí | No | No | No |
| Co-autores en el commit | No encontrado | No | Sí | No | No |
| Enlaces a issues | No encontrado | Sí | Sí | Sí | No |
| Acciones personalizadas | Parcial (comando git propio) | Sí | No | No | Sí |
| Espacios de trabajo (grupos de repos) | No encontrado | Sí | No | No | No |
| Abrir en editores o IDEs externos | Parcial (terminal y explorador) | Sí | Sí | No | Sí |
| Integración con el explorador de archivos | No | No | No | Sí (núcleo del producto) | No |
| Actualización automática | No | No | Sí | Sí | No |
| Instaladores publicados | No | Sí | Sí | Sí | Sí |

## Funciones faltantes sugeridas

Ordenadas por relación entre valor y esfuerzo estimado.

| Prioridad | Función | Referencia | Esfuerzo estimado |
|-----------|---------|------------|-------------------|
| 1 | Diff de imágenes (lado a lado, deslizador, mezcla) | SourceGit, GitHub Desktop | Medio: el diff actual es de texto; hay que leer blobs binarios por `git show` |
| 2 | Abrir repositorio o archivo en editor externo configurable | SourceGit, GitHub Desktop, git-cola | Bajo: ajuste con comando y operación en `AppOps` |
| 3 | Co-autores en el formulario de commit (`Co-authored-by:`) | GitHub Desktop | Bajo |
| 4 | Ayuda para commits convencionales con tipos por repositorio | SourceGit | Bajo a medio |
| 5 | Enlaces a issues en mensajes (regla por repositorio) | SourceGit, GitHub Desktop | Medio |
| 6 | Espacios de trabajo: agrupar pestañas de repositorios | SourceGit | Medio |
| 7 | Acciones personalizadas con plantillas (variables como la rama o el commit) | SourceGit, git-cola | Medio |
| 8 | Más idiomas (la guía de [codigo.md](codigo.md#agregar-un-idioma) lo hace mecánico) | SourceGit | Bajo por idioma |
| 9 | Mensaje de commit asistido por IA, opcional y con proveedor configurable | SourceGit | Medio; requiere decidir qué se envía al proveedor y cómo se guarda la clave |
| 10 | Actualización automática e instaladores publicados | GitHub Desktop | Medio; depende de dónde se publiquen los binarios |

Los puntos 9 y 10 tienen implicaciones de privacidad y de entrega que conviene decidir antes de implementarlos.

## Cómo mantener este documento

Al agregar una función de la tabla, cambia su celda a "Sí" y quítala de la lista de faltantes. Si se confirman TortoiseGit y git-cola con su documentación oficial, reemplaza la nota de confianza.

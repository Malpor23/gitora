# Aspectos legales

> Este documento es informativo y no constituye asesoría legal. Si vas a distribuir
> Gitora comercialmente o a manejar datos de terceros, consulta a un abogado.

## Licencia

Gitora se publica bajo la licencia **MIT** ([LICENSE](../LICENSE)): se puede usar, copiar,
modificar y distribuir, incluso con fines comerciales, conservando el aviso de copyright.
El software se entrega «tal cual», sin garantía de ningún tipo.

Los componentes de terceros que se redistribuyen y sus licencias están en
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md). Gitora no incluye Git: ejecuta el
`git` que ya tiene instalado el usuario como proceso aparte.

## Marcas registradas

Git, GitHub, GitLab, Bitbucket, Gitea, Forgejo, Codeberg, Windows, Linux y otros nombres
que aparecen en la aplicación y en la documentación son marcas de sus respectivos
titulares. Se usan solo para indicar compatibilidad (uso nominativo).
**Gitora es un proyecto independiente: no está afiliado, patrocinado ni respaldado por
ninguno de ellos.**

## Privacidad y datos

- Gitora **no incluye telemetría ni analítica** y no envía datos a servidores del autor.
  (Verificado al 12 nov 2026 en el código: las únicas conexiones de red son las que el
  usuario provoca contra su propio proveedor Git, p. ej. `api.github.com`, `gitlab.com`.)
- Las credenciales de las cuentas (tokens, contraseñas) se guardan cifradas con el
  almacén del sistema (`safeStorage` de Electron) en el equipo del usuario. Si el sistema
  no ofrece cifrado, no se guardan.
- Los repositorios y sus datos permanecen en el equipo del usuario.
- El autor no recopila datos personales; por tanto no actúa como responsable ni encargado
  del tratamiento de los datos de los usuarios de la aplicación.

## Contacto

Dudas legales o retiro de contenido: mg230886@gmail.com.

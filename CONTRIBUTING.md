# Cómo contribuir a Gitora

Gracias por querer aportar. Todo cambio entra por pull request en [https://github.com/malpor23/gitora](https://github.com/malpor23/gitora).

## Flujo

1. Haz un fork y crea una rama desde `main` (`feat/nombre`, `fix/nombre`).
2. Instala y prueba: `npm ci`, `npm test`, `npm run test:core`, `npm run build` y, si tocas la interfaz, `npm run test:e2e` (necesita pantalla).
3. Mantén los cambios pequeños y enfocados, con sus pruebas y documentación.
4. Usa [Conventional Commits](https://www.conventionalcommits.org/es/) (`feat:`, `fix:`, `docs:`...).
5. Abre el pull request. Debe pasar el CI y recibir la aprobación de un mantenedor.

## Convenciones

- Código, identificadores y textos de interfaz base en inglés; la documentación en español.
- Toda cadena de interfaz va en `src/app/core/i18n/locales/` (en y es).
- Si agregas o actualizas una dependencia que viaja en la app (`dependencies` de `package.json`), revisa su licencia y actualiza [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Con `npm ls --omit=dev --all` ves el árbol que se distribuye.
- La guía de estructura y de cómo agregar comandos está en [docs/codigo.md](docs/codigo.md); el entorno de desarrollo en [docs/desarrollo.md](docs/desarrollo.md).

## Reportar errores y proponer funciones

Usa las plantillas de issues. Para vulnerabilidades, lee [SECURITY.md](SECURITY.md) y no abras un issue público.

Al contribuir aceptas que tu aporte se publique bajo la licencia MIT del proyecto y declaras que tienes derecho a aportarlo (código propio o con licencia compatible). Más en [docs/legal.md](docs/legal.md).

import type { MenuItemConstructorOptions } from 'electron';
import type { Language } from '@core/models';
import { en } from '../src/app/core/i18n/locales/en';
import { es } from '../src/app/core/i18n/locales/es';

const DICTS = { es, en } satisfies Record<Language, unknown>;

/**
 * Plantilla del menú de la aplicación. Cada entrada usa un `role` (el comportamiento nativo)
 * pero con la etiqueta traducida: Electron localiza los roles según el idioma del sistema, no
 * según el de la app, así que sin `label` explícito el menú no cambiaría con el idioma elegido.
 */
export interface AppMenuOptions {
  isDev: boolean;
  isMac: boolean;
  appName: string;
  /** Hay un repositorio activo: sin él las entradas del menú Repository se deshabilitan. */
  repoActive: boolean;
  /** Se invoca con el id del comando de la interfaz que debe ejecutarse. */
  onCommand: (id: string) => void;
}

/** Entradas del menú Repository: clave i18n (`menu.repo.*`) y comando de la interfaz que ejecutan. */
export const REPOSITORY_MENU = {
  refresh: 'repo.refresh',
  fetch: 'remote.fetch',
  pull: 'remote.pull',
  push: 'remote.push',
  saveStash: 'stash.save',
  newBranch: 'branch.create',
  newTag: 'tag.create',
  newWorktree: 'wt.add',
  flowInit: 'flow.init',
  flowFeature: 'flow.feature',
  flowRelease: 'flow.release',
  flowHotfix: 'flow.hotfix',
  flowDeinit: 'flow.deinit',
  stats: 'repo.stats',
  treemap: 'repo.treemap',
  benchmark: 'repo.benchmark',
  settings: 'repo.config',
} as const;

export function appMenuTemplate(
  lang: Language,
  opts: AppMenuOptions,
): MenuItemConstructorOptions[] {
  const t = DICTS[lang].menu;
  const sep: MenuItemConstructorOptions = { type: 'separator' };
  // "Cerrar ventana": el rol `close` trae Ctrl+W, pero en Gitora Ctrl+W cierra el repositorio activo.
  // Sin registrar el atajo, el menú no se lo quita a la interfaz.
  const closeWindow: MenuItemConstructorOptions = {
    role: 'close',
    label: t.close,
    registerAccelerator: false,
  };

  const appMenu: MenuItemConstructorOptions[] = opts.isMac
    ? [{ label: opts.appName, submenu: [{ role: 'quit', label: t.quit }] }]
    : [];

  const file: MenuItemConstructorOptions = {
    label: t.file,
    submenu: opts.isMac ? [closeWindow] : [closeWindow, sep, { role: 'quit', label: t.quit }],
  };

  const edit: MenuItemConstructorOptions = {
    label: t.edit,
    submenu: [
      { role: 'undo', label: t.undo },
      { role: 'redo', label: t.redo },
      sep,
      { role: 'cut', label: t.cut },
      { role: 'copy', label: t.copy },
      { role: 'paste', label: t.paste },
      { role: 'selectAll', label: t.selectAll },
    ],
  };

  const view: MenuItemConstructorOptions = {
    label: t.view,
    submenu: [
      ...(opts.isDev
        ? ([
            { role: 'reload', label: t.reload },
            { role: 'forceReload', label: t.forceReload },
            { role: 'toggleDevTools', label: t.devTools },
            sep,
          ] satisfies MenuItemConstructorOptions[])
        : []),
      { role: 'resetZoom', label: t.resetZoom },
      { role: 'zoomIn', label: t.zoomIn },
      { role: 'zoomOut', label: t.zoomOut },
      sep,
      { role: 'togglefullscreen', label: t.fullscreen },
    ],
  };

  const r = DICTS[lang].menu.repo;
  const item = (key: keyof typeof REPOSITORY_MENU): MenuItemConstructorOptions => ({
    id: REPOSITORY_MENU[key],
    label: r[key],
    enabled: opts.repoActive,
    click: () => opts.onCommand(REPOSITORY_MENU[key]),
  });
  const repository: MenuItemConstructorOptions = {
    label: t.repository,
    submenu: [
      item('refresh'),
      sep,
      item('fetch'),
      item('pull'),
      item('push'),
      sep,
      item('saveStash'),
      sep,
      item('newBranch'),
      item('newTag'),
      item('newWorktree'),
      sep,
      {
        label: r.gitFlow,
        enabled: opts.repoActive,
        submenu: [
          item('flowInit'),
          sep,
          item('flowFeature'),
          item('flowRelease'),
          item('flowHotfix'),
          sep,
          item('flowDeinit'),
        ],
      },
      sep,
      item('stats'),
      item('treemap'),
      item('benchmark'),
      sep,
      item('settings'),
    ],
  };

  const window: MenuItemConstructorOptions = {
    label: t.window,
    submenu: [{ role: 'minimize', label: t.minimize }, closeWindow],
  };

  return [...appMenu, file, edit, view, repository, window];
}

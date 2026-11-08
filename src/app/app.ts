import { Component, computed, effect, HostListener, inject, signal } from '@angular/core';

import { I18n } from '@core/i18n';
import { TPipe } from '@core/i18n/i18n';
import {
  BridgeService,
  ContextMenuService,
  DialogService,
  SettingsService,
  WorkspaceService,
} from '@core/services';
import { Commands, GitFlows } from '@features/actions';
import { Changes } from '@features/changes';
import { ConsolePanel } from '@features/console-panel';
import { Viewer } from '@features/history';
import { Sidebar } from '@features/sidebar';
import { Welcome } from '@features/welcome';
import { HostsLayout } from '@layout/hosts-layout/hosts-layout';
import { Icon } from '@shared/components';

/** Ítems de cada dropdown de la barra de herramientas (ids de `Commands`; '-' separa, '#clave' titula). */
const TOOLBAR_MENUS = {
  fetch: ['remote.fetch', 'remote.fetchAll'],
  pull: ['remote.pull'],
  push: ['remote.push', 'remote.forcePush', 'tag.pushAll'],
  branch: [
    'branch.create',
    'wt.add',
    '-',
    '#menu.repo.gitFlow',
    'flow.feature',
    'flow.release',
    'flow.hotfix',
    'flow.init',
    'flow.deinit',
    '-',
    'branch.checkout',
    'branch.rename',
    'branch.delete',
  ],
  rebase: [
    'merge.interactive',
    'merge.cherryPick',
    'merge.revert',
    'merge.reset',
    '-',
    'merge.continue',
    'merge.skip',
    'merge.abort',
  ],
  stash: ['stash.save', 'stash.pop', 'stash.clear'],
  repository: [
    'repo.refresh',
    '-',
    'tag.create',
    '-',
    'tools.am',
    'history.bisect',
    'history.reflog',
    '-',
    'repo.stats',
    'repo.treemap',
    'repo.benchmark',
    'tools.gc',
    'tools.archive',
    '-',
    'repo.identity',
    'repo.config',
  ],
} as const;
export type ToolbarMenu = keyof typeof TOOLBAR_MENUS;

@Component({
  imports: [TPipe, Icon, Sidebar, Changes, Viewer, Welcome, ConsolePanel, HostsLayout],
  selector: 'app-root',
  host: { class: 'block h-screen' },
  templateUrl: './app.html',
})
export class App {
  readonly ws = inject(WorkspaceService);
  readonly settings = inject(SettingsService);
  readonly flows = inject(GitFlows);
  private readonly commands = inject(Commands);
  private readonly dialogs = inject(DialogService);
  private readonly menu = inject(ContextMenuService);
  private readonly bridge = inject(BridgeService);
  private readonly i18n = inject(I18n);

  readonly ready = signal(false);
  readonly bootError = signal<string | null>(null);
  readonly bridgeMissing = !this.bridge.available;
  readonly sidebarWidth = signal(260);
  readonly consoleHeight = signal(220);
  readonly store = computed(() => this.ws.active());
  readonly isMac = computed(() => this.settings.platform() === 'darwin');

  constructor() {
    if (this.bridgeMissing) return;
    // El menú nativo Repository pide ejecutar comandos de la interfaz y solo se habilita con un repo activo.
    this.bridge.on('menu-command', ({ id }) => this.commands.execute(id, this.store()));
    effect(() => void this.bridge.app('setRepoActive', !!this.store()).catch(() => undefined));
    void this.boot();
  }

  private async boot() {
    try {
      await this.settings.load();
      this.sidebarWidth.set(this.settings.value.sidebarWidth);
      this.consoleHeight.set(this.settings.value.consoleHeight);
      this.ws.init();
      await this.ws.restore();
    } catch (e) {
      this.bootError.set(e instanceof Error ? e.message : String(e));
      return;
    }
    this.ready.set(true);
    // Precargar el diálogo genérico: así el primer diálogo abre al instante y no se pierden teclas
    void import('@features/dialogs/form-dialog/form-dialog');
  }

  async openPalette() {
    const { CommandPalette } = await import('@features/command-palette');
    await this.dialogs.open(CommandPalette, {}, 640);
  }

  @HostListener('window:keydown', ['$event'])
  onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      if (this.menu.state()) this.menu.close();
      else this.dialogs.closeTop();
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.shiftKey && e.key.toLowerCase() === 'p') {
      e.preventDefault();
      if (!this.dialogs.stack().length) void this.openPalette();
      return;
    }
    // Con un diálogo abierto o escribiendo en un campo, solo los atajos con modificador
    const typing = (e.target as HTMLElement)?.closest('input, textarea, select, [contenteditable]');
    if (this.dialogs.stack().length) return;
    if (typing && !mod && e.key !== 'F5') return;
    this.commands.handleKey(e, this.store());
  }

  /** Redimensionar el sidebar y la consola arrastrando el borde. */
  startResize(e: PointerEvent, what: 'sidebar' | 'console') {
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = this.sidebarWidth();
    const startH = this.consoleHeight();
    const move = (ev: PointerEvent) => {
      if (what === 'sidebar')
        this.sidebarWidth.set(Math.min(480, Math.max(190, startW + ev.clientX - startX)));
      else
        this.consoleHeight.set(
          Math.min(window.innerHeight * 0.7, Math.max(100, startH - (ev.clientY - startY))),
        );
    };
    const up = () => {
      void this.settings.update({ sidebarWidth: Math.round(this.sidebarWidth()), consoleHeight: Math.round(this.consoleHeight()) });
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  tabMenu(e: MouseEvent, path: string) {
    this.menu.open(e, [
      {
        label: this.i18n.t('commands.showInFolder'),
        icon: 'folder',
        action: () => this.bridge.app('showInFolder', path),
      },
      {
        label: this.i18n.t('commands.openTerminal'),
        icon: 'terminal',
        action: () => this.bridge.app('openTerminal', path),
      },
      { separator: true },
      { label: this.i18n.t('titlebar.closeTab'), icon: 'x', action: () => this.ws.close(path) },
    ]);
  }

  /** Despliega el dropdown de un botón de la barra, anclado al propio botón. */
  openToolbarMenu(e: Event, kind: ToolbarMenu) {
    e.stopPropagation();
    this.menu.openAt(
      e.currentTarget as HTMLElement,
      this.commands.menu(TOOLBAR_MENUS[kind], this.store()),
    );
  }

  /** Cierra la pestaña con clic central. No devuelve valor: un `false` en la plantilla haría preventDefault(). */
  closeOnMiddleClick(e: MouseEvent, path: string) {
    if (e.button === 1) this.ws.close(path);
  }

  openTerminal(path: string) {
    void this.bridge.app('openTerminal', path);
  }

  showInFolder(path: string) {
    void this.bridge.app('showInFolder', path);
  }

  toggleTheme() {
    void this.settings.update({ theme: this.settings.isDark() ? 'light' : 'dark' });
  }

  toggleLanguage() {
    void this.settings.update({ language: this.settings.value.language === 'es' ? 'en' : 'es' });
  }
}

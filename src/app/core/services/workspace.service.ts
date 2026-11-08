import { computed, inject, Service, signal } from '@angular/core';

import { I18n } from '@core/i18n';
import { CommandLogEntry, RepoInfo } from '@core/models';
import { BridgeService } from '@core/services/bridge.service';
import { NotifyService } from '@core/services/notify.service';
import { SettingsService } from '@core/services/settings.service';
import { RepositoryStore } from '@core/store';

@Service()
export class WorkspaceService {
  private readonly bridge = inject(BridgeService);
  private readonly notify = inject(NotifyService);
  private readonly i18n = inject(I18n);
  private readonly settings = inject(SettingsService);

  readonly tabs = signal<RepositoryStore[]>([]);
  readonly activePath = signal<string | null>(null);
  readonly active = computed(() => this.tabs().find((t) => t.path() === this.activePath()) ?? null);
  readonly commandLog = signal<CommandLogEntry[]>([]);
  readonly showConsole = signal(false);
  readonly showWelcome = signal(false);
  private fetchTimer: ReturnType<typeof setInterval> | null = null;

  init() {
    this.bridge.on('command-log', (entry) => {
      this.commandLog.update((list) => {
        const idx = list.findIndex((e) => e.id === entry.id);
        const next = idx >= 0 ? list.map((e, i) => (i === idx ? entry : e)) : [...list, entry];
        return next.slice(-400);
      });
    });
    this.bridge.on('repo-changed', ({ repo, gitOnly }) => {
      const tab = this.tabs().find((t) => t.path() === repo);
      if (tab) void tab.refresh(gitOnly || tab === this.active());
    });
    this.bridge.on('window-focus', ({ focused }) => {
      if (focused) void this.active()?.refresh(true);
    });
    this.showConsole.set(this.settings.value.showConsole);
    this.scheduleAutoFetch();
  }

  async restore() {
    const s = this.settings.value;
    for (const p of s.openRepos) {
      await this.open(p, { silent: true, activate: false });
    }
    const target =
      s.activeRepo && this.tabs().some((t) => t.path() === s.activeRepo)
        ? s.activeRepo
        : this.tabs()[0]?.path();
    if (target) this.activate(target);
  }

  async open(
    dir: string,
    opts: { silent?: boolean; activate?: boolean } = {},
  ): Promise<RepositoryStore | null> {
    try {
      const info: RepoInfo = await this.bridge.git('open', dir);
      let tab = this.tabs().find((t) => t.path() === info.path);
      if (!tab) {
        tab = new RepositoryStore(info, this.bridge, this.notify, this.i18n);
        this.tabs.update((t) => [...t, tab!]);
        await this.bridge.app('watchRepo', info.path);
        void tab.refresh();
      }
      if (opts.activate !== false) this.activate(info.path);
      await this.persist();
      return tab;
    } catch (e) {
      if (!opts.silent) this.notify.error(e);
      return null;
    }
  }

  activate(path: string) {
    this.activePath.set(path);
    this.showWelcome.set(false);
    void this.settings.update({ activeRepo: path });
  }

  async close(path: string) {
    const tabs = this.tabs();
    const idx = tabs.findIndex((t) => t.path() === path);
    if (idx === -1) return;
    await this.bridge.app('unwatchRepo', path);
    const next = tabs.filter((t) => t.path() !== path);
    this.tabs.set(next);
    if (this.activePath() === path)
      this.activePath.set(next[Math.min(idx, next.length - 1)]?.path() ?? null);
    await this.persist();
  }

  toggleConsole() {
    this.showConsole.update((v) => !v);
    void this.settings.update({ showConsole: this.showConsole() });
  }

  clearConsole() {
    this.commandLog.set([]);
  }

  private async persist() {
    await this.settings.update({
      openRepos: this.tabs().map((t) => t.path()),
      activeRepo: this.activePath(),
    });
  }

  scheduleAutoFetch() {
    if (this.fetchTimer) clearInterval(this.fetchTimer);
    const minutes = this.settings.value.fetchInterval;
    if (!minutes) return;
    this.fetchTimer = setInterval(() => {
      const tab = this.active();
      if (!tab || tab.busy() || !tab.remotes().length) return;
      void this.bridge
        .git('fetch', tab.path(), { prune: true })
        .then(() => tab.refresh())
        .catch(() => {
          /* fetch silencioso: sin red no molestamos */
        });
    }, minutes * 60_000);
  }
}

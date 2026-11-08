import { computed, effect, inject, Service, signal } from '@angular/core';

import { I18n } from '@core/i18n';
import { Settings } from '@core/models';
import { BridgeService } from '@core/services/bridge.service';

@Service()
export class SettingsService {
  private readonly bridge = inject(BridgeService);
  private readonly i18n = inject(I18n);

  readonly settings = signal<Settings | null>(null);
  readonly gitVersion = signal<string | null>(null);
  readonly platform = signal<string>('linux');
  private readonly systemDark = signal(window.matchMedia('(prefers-color-scheme: dark)').matches);

  readonly isDark = computed(() => {
    const theme = this.settings()?.theme ?? 'dark';
    return theme === 'dark' || (theme === 'system' && this.systemDark());
  });

  constructor() {
    window
      .matchMedia('(prefers-color-scheme: dark)')
      .addEventListener('change', (e) => this.systemDark.set(e.matches));
    effect(() => {
      const dark = this.isDark();
      document.documentElement.dataset['theme'] = dark ? 'dark' : 'light';
      if (this.bridge.available) this.bridge.app('setTitleBarTheme', dark);
    });
    effect(() => {
      const size = this.settings()?.fontSize ?? 13;
      document.documentElement.style.setProperty('--font-size', `${size}px`);
    });
  }

  async load() {
    const s = await this.bridge.app('getSettings');
    this.settings.set(s);
    this.i18n.setLanguage(s.language);
    this.platform.set(await this.bridge.app('platform'));
    this.gitVersion.set(await this.bridge.app('gitVersion'));
  }

  async update(patch: Partial<Settings>) {
    const s = await this.bridge.app('updateSettings', patch);
    this.settings.set(s);
    if (patch.language) this.i18n.setLanguage(patch.language);
    if (patch.gitPath !== undefined) this.gitVersion.set(await this.bridge.app('gitVersion'));
    return s;
  }

  /** Recarga desde disco (p. ej. tras agregar una cuenta). */
  async reload() {
    this.settings.set(await this.bridge.app('getSettings'));
  }

  get value(): Settings {
    const s = this.settings();
    if (!s) throw new Error('Settings not loaded');
    return s;
  }
}

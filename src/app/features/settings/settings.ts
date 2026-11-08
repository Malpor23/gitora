import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { I18n, LANGUAGES, TPipe } from '@core/i18n/i18n';
import { Settings as ISettings } from '@core/models';
import {
  BridgeService,
  DIALOG_DATA,
  DIALOG_REF,
  DialogRef,
  SettingsService,
} from '@core/services';
import { Icon } from '@shared/components';

import { AccountsTab } from './accounts/accounts-tab';

type Tab = 'general' | 'git' | 'diff' | 'accounts' | 'about';

@Component({
  imports: [FormsModule, TPipe, Icon, AccountsTab],
  selector: 'gt-settings',
  templateUrl: './settings.html',
})
export class Settings {
  readonly data = inject(DIALOG_DATA) as { tab?: Tab };
  readonly ref = inject(DIALOG_REF) as DialogRef;
  readonly svc = inject(SettingsService);
  private readonly bridge = inject(BridgeService);
  private readonly i18n = inject(I18n);

  readonly languages = LANGUAGES;
  readonly tabs: Tab[] = ['general', 'git', 'diff', 'accounts', 'about'];
  readonly tab = signal<Tab>(this.data?.tab ?? 'general');
  readonly s = computed(() => this.svc.settings()!);

  update<K extends keyof ISettings>(key: K, value: ISettings[K]) {
    void this.svc.update({ [key]: value } as Partial<ISettings>);
  }

  async browseCloneDir() {
    const dir = await this.bridge.app('pickDirectory', this.i18n.t('settings.defaultCloneDir'));
    if (dir) this.update('defaultCloneDir', dir);
  }
}

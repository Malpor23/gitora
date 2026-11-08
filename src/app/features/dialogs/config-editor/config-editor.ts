import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { TPipe } from '@core/i18n/i18n';
import { BridgeService, DIALOG_DATA, DIALOG_REF, DialogRef, NotifyService } from '@core/services';
import { RepositoryStore } from '@core/store';
import { Icon } from '@shared/components';

@Component({
  imports: [TPipe, Icon, FormsModule],
  selector: 'gt-config-editor',
  templateUrl: './config-editor.html',
})
export class ConfigEditor {
  readonly data = inject(DIALOG_DATA) as { store: RepositoryStore };
  readonly ref = inject(DIALOG_REF) as DialogRef;
  private readonly bridge = inject(BridgeService);
  private readonly notify = inject(NotifyService);

  readonly scope = signal<'local' | 'global'>('local');
  readonly values = signal<Record<string, string>>({});
  readonly rows = computed(() =>
    Object.entries(this.values()).sort(([a], [b]) => a.localeCompare(b)),
  );
  readonly newKey = signal('');
  readonly newValue = signal('');

  constructor() {
    void this.load('local');
  }

  async load(scope: 'local' | 'global') {
    this.scope.set(scope);
    this.values.set(await this.bridge.git('configList', this.data.store.path(), scope));
  }

  async set(key: string, value: string) {
    try {
      await this.bridge.git('configSet', this.data.store.path(), key, value, this.scope());
      this.notify.success('common.done');
    } catch (e) {
      this.notify.error(e);
    }
  }

  async unset(key: string) {
    try {
      await this.bridge.git('configUnset', this.data.store.path(), key, this.scope());
      await this.load(this.scope());
    } catch (e) {
      this.notify.error(e);
    }
  }

  async add() {
    await this.set(this.newKey().trim(), this.newValue());
    this.newKey.set('');
    this.newValue.set('');
    await this.load(this.scope());
  }
}

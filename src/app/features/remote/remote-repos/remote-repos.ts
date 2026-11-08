import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { RelTimePipe, TPipe } from '@core/i18n/i18n';
import { RemoteRepository } from '@core/models';
import { BridgeService, DIALOG_REF, DialogRef, SettingsService } from '@core/services';
import { ProviderMark } from '@features/remote';
import { Icon } from '@shared/components';

@Component({
  imports: [FormsModule, TPipe, RelTimePipe, Icon, ProviderMark],
  selector: 'gt-remote-repos',
  templateUrl: './remote-repos.html',
})
export class RemoteRepos {
  readonly ref = inject(DIALOG_REF) as DialogRef<{ url: string; name: string }>;
  private readonly bridge = inject(BridgeService);
  private readonly settings = inject(SettingsService);

  readonly accounts = computed(() => this.settings.settings()?.accounts ?? []);
  readonly accountId = signal<string>('');
  readonly repos = signal<RemoteRepository[]>([]);
  readonly query = signal('');
  readonly ssh = signal(false);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly filtered = computed(() => {
    const q = this.query().toLowerCase();
    return this.repos().filter(
      (r) => !q || r.fullName.toLowerCase().includes(q) || r.description.toLowerCase().includes(q),
    );
  });

  constructor() {
    const first = this.accounts()[0];
    if (first) void this.pick(first.id);
  }

  async pick(id: string) {
    this.accountId.set(id);
    this.loading.set(true);
    this.error.set(null);
    this.repos.set([]);
    try {
      this.repos.set(await this.bridge.app('listRemoteRepos', id, ''));
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.loading.set(false);
    }
  }

  clone(r: RemoteRepository) {
    this.ref.close({ url: this.ssh() && r.sshUrl ? r.sshUrl : r.cloneUrl, name: r.name });
  }
}

import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { RelTimePipe, TPipe } from '@core/i18n/i18n';
import { PullRequest } from '@core/models';
import { BridgeService, DIALOG_DATA, DIALOG_REF, DialogRef } from '@core/services';
import { RepositoryStore } from '@core/store';
import { GitFlows } from '@features/actions';
import { Icon } from '@shared/components';

@Component({
  imports: [FormsModule, TPipe, RelTimePipe, Icon],
  selector: 'gt-pull-requests',
  templateUrl: './pull-requests.html',
})
export class PullRequests {
  readonly data = inject(DIALOG_DATA) as { store: RepositoryStore };
  readonly ref = inject(DIALOG_REF) as DialogRef;
  private readonly bridge = inject(BridgeService);
  private readonly flows = inject(GitFlows);

  readonly remote = signal(this.data.store.remotes()[0]?.name ?? '');
  readonly prs = signal<PullRequest[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  private readonly remoteBranchNames = computed(
    () => new Set(this.data.store.remoteBranches().map((b) => b.name)),
  );

  constructor() {
    if (this.remote()) void this.load(this.remote());
  }

  async load(remote: string) {
    this.remote.set(remote);
    this.loading.set(true);
    this.error.set(null);
    try {
      this.prs.set(await this.bridge.app('pullRequests', this.data.store.path(), remote));
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : String(e));
      this.prs.set([]);
    } finally {
      this.loading.set(false);
    }
  }

  hasRemoteBranch(p: PullRequest) {
    return this.remoteBranchNames().has(`${this.remote()}/${p.sourceBranch}`);
  }

  checkout(p: PullRequest) {
    this.ref.close();
    void this.flows.checkout(this.data.store, `${this.remote()}/${p.sourceBranch}`);
  }

  open(p: PullRequest) {
    void this.bridge.app('openExternal', p.url);
  }

  create() {
    this.ref.close();
    void this.flows.createPullRequest(this.data.store);
  }
}

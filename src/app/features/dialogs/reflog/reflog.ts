import { Component, inject, signal } from '@angular/core';

import { RelTimePipe, TPipe } from '@core/i18n/i18n';
import { ReflogEntry } from '@core/models';
import { BridgeService, DIALOG_DATA, DIALOG_REF, DialogRef } from '@core/services';
import { RepositoryStore } from '@core/store';
import { GitFlows } from '@features/actions';
import { Icon } from '@shared/components';

@Component({
  imports: [TPipe, RelTimePipe, Icon],
  selector: 'gt-reflog',
  templateUrl: './reflog.html',
})
export class Reflog {
  readonly data = inject(DIALOG_DATA) as { store: RepositoryStore };
  readonly ref = inject(DIALOG_REF) as DialogRef;
  private readonly bridge = inject(BridgeService);
  private readonly flows = inject(GitFlows);
  readonly entries = signal<ReflogEntry[]>([]);

  constructor() {
    void this.bridge.git('reflog', this.data.store.path(), 300).then((e) => this.entries.set(e));
  }

  show(e: ReflogEntry) {
    this.data.store.setFilter({ all: true, search: '', path: null, ref: null });
    this.data.store.selectCommit(e.hash);
    this.ref.close();
  }

  checkout(e: ReflogEntry) {
    this.ref.close();
    void this.flows.checkoutCommit(this.data.store, e.hash);
  }

  reset(e: ReflogEntry) {
    this.ref.close();
    void this.flows.reset(this.data.store, e.hash);
  }
}

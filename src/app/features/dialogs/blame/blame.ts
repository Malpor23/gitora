import { Component, computed, inject, signal } from '@angular/core';

import { RelTimePipe, TPipe } from '@core/i18n/i18n';
import { BlameLine } from '@core/models';
import { BridgeService, DIALOG_DATA, DIALOG_REF, DialogRef, NotifyService } from '@core/services';
import { RepositoryStore } from '@core/store';
import { Icon } from '@shared/components';

@Component({
  imports: [TPipe, RelTimePipe, Icon],
  selector: 'gt-blame',
  templateUrl: './blame.html',
})
export class Blame {
  readonly data = inject(DIALOG_DATA) as {
    store: RepositoryStore;
    path: string;
    rev: string | null;
  };
  readonly ref = inject(DIALOG_REF) as DialogRef;
  private readonly bridge = inject(BridgeService);
  private readonly notify = inject(NotifyService);
  readonly lines = signal<BlameLine[]>([]);

  /** Marca el inicio de cada bloque del mismo commit y alterna el fondo por bloque. */
  readonly rows = computed(() => {
    let alt = false;
    return this.lines().map((l, i, arr) => {
      const first = i === 0 || arr[i - 1].hash !== l.hash;
      if (first && i > 0) alt = !alt;
      return { ...l, first, alt };
    });
  });

  constructor() {
    void this.bridge
      .git('blame', this.data.store.path(), this.data.path, this.data.rev)
      .then((l) => this.lines.set(l))
      .catch((e) => {
        this.notify.error(e);
        this.ref.close();
      });
  }

  open(hash: string) {
    if (/^0+$/.test(hash)) return;
    this.data.store.selectCommit(hash);
    this.ref.close();
  }
}

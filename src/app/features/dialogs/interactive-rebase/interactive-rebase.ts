import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { I18n, TPipe } from '@core/i18n/i18n';
import { RebaseAction, RebaseTodoItem } from '@core/models';
import { BridgeService, DIALOG_DATA, DIALOG_REF, DialogRef } from '@core/services';
import { RepositoryStore } from '@core/store';
import { Icon } from '@shared/components';

const ACTIONS: RebaseAction[] = ['pick', 'reword', 'edit', 'squash', 'fixup', 'drop'];

@Component({
  imports: [FormsModule, TPipe, Icon],
  selector: 'gt-interactive-rebase',
  templateUrl: './interactive-rebase.html',
})
export class InteractiveRebase {
  readonly data = inject(DIALOG_DATA) as { store: RepositoryStore; base: string };
  readonly ref = inject(DIALOG_REF) as DialogRef<{ todo: RebaseTodoItem[]; autostash: boolean }>;
  private readonly bridge = inject(BridgeService);
  private readonly i18n = inject(I18n);

  readonly actions = ACTIONS;
  readonly shortBase = /^[0-9a-f]{40}$/.test(this.data.base)
    ? this.data.base.slice(0, 8)
    : this.data.base;
  readonly items = signal<RebaseTodoItem[]>([]);
  readonly loading = signal(true);
  readonly dragIndex = signal<number | null>(null);
  readonly autostash = signal(true);
  readonly hasStart = computed(() => this.items().length > 0);

  constructor() {
    const s = this.data.store;
    const range = this.data.base === '--root' ? 'HEAD' : `${this.data.base}..HEAD`;
    void this.bridge
      .git('log', s.path(), { ref: range, limit: 500, firstParent: false })
      .then((commits) => {
        // git aplica el todo de más antiguo a más reciente
        this.items.set(
          commits
            .filter((c) => c.parents.length <= 1)
            .reverse()
            .map((c) => ({ action: 'pick', hash: c.hash, subject: c.subject })),
        );
        this.loading.set(false);
      })
      .catch(() => this.loading.set(false));
  }

  over(i: number) {
    const from = this.dragIndex();
    if (from === null || from === i) return;
    this.items.update((list) => {
      const copy = [...list];
      const [moved] = copy.splice(from, 1);
      copy.splice(i, 0, moved);
      return this.fixFirst(copy);
    });
    this.dragIndex.set(i);
  }

  private fixFirst(list: RebaseTodoItem[]) {
    if (list[0] && (list[0].action === 'squash' || list[0].action === 'fixup'))
      list[0] = { ...list[0], action: 'pick' };
    return list;
  }

  setAction(i: number, action: RebaseAction) {
    this.items.update((list) =>
      list.map((it, k) =>
        k === i
          ? { ...it, action, message: it.message ?? (action === 'reword' ? it.subject : undefined) }
          : it,
      ),
    );
  }

  setMessage(i: number, message: string) {
    this.items.update((list) => list.map((it, k) => (k === i ? { ...it, message } : it)));
  }

  isLastSquash(i: number) {
    const next = this.items()[i + 1];
    return !next || next.action !== 'squash';
  }

  start() {
    this.ref.close({ todo: this.items(), autostash: this.autostash() });
  }
}

import { Component, computed, inject, signal } from '@angular/core';

import { I18n, TPipe } from '@core/i18n/i18n';
import { RepoStats } from '@core/models';
import { BridgeService, DIALOG_DATA, DIALOG_REF, DialogRef } from '@core/services';
import { RepositoryStore } from '@core/store';
import { Icon } from '@shared/components';

import { barWidth, formatKib, shortMonth } from './repo-stats.format';

@Component({
  imports: [TPipe, Icon],
  selector: 'gt-repo-stats',
  template: `
    <div class="dialog">
      <header class="dialog-head">
        <h2>{{ 'dialogs.repoStats.title' | t }}</h2>
        <button class="icon-btn" [attr.aria-label]="'common.close' | t" (click)="ref.close()">
          <gt-icon name="x" />
        </button>
      </header>
      <div class="dialog-body max-h-[70vh] overflow-auto">
        @if (loading()) {
          <p class="muted flex items-center gap-2" role="status">
            <span class="spinner"></span>{{ 'app.loading' | t }}
          </p>
        } @else if (error(); as msg) {
          <p class="m-0 text-danger" role="alert">{{ msg }}</p>
        } @else if (stats(); as s) {
          @if (s.commits === 0) {
            <p class="muted m-0">{{ 'dialogs.repoStats.empty' | t }}</p>
          } @else {
            <dl class="m-0 grid grid-cols-3 gap-2">
              @for (c of cards(); track c.label) {
                <div class="rounded-md border border-line bg-surface-2 px-3 py-2">
                  <dt class="text-[.82em] text-muted">{{ c.label | t }}</dt>
                  <dd class="m-0 mt-0.5 text-[1.15em] font-semibold text-fg">{{ c.value }}</dd>
                </div>
              }
            </dl>

            <h3 class="mt-4 mb-2 text-[1em] font-semibold">
              {{ 'dialogs.repoStats.activity' | t }}
            </h3>
            <ul
              class="m-0 flex h-32 list-none items-end gap-1.5 rounded-md border border-line bg-surface-2 p-2 pb-1"
            >
              @for (a of s.activity; track a.month) {
                <li
                  class="flex h-full min-w-0 flex-1 flex-col justify-end gap-1"
                  [attr.aria-label]="
                    a.month + ': ' + ('dialogs.repoStats.commitCount' | t: { n: a.commits })
                  "
                  [title]="a.month + ': ' + ('dialogs.repoStats.commitCount' | t: { n: a.commits })"
                >
                  <div class="flex flex-1 items-end">
                    <div
                      class="w-full rounded-t-sm bg-accent"
                      [style.height.%]="a.commits > 0 ? max(barH(a.commits), 4) : 0"
                    ></div>
                  </div>
                  <span class="truncate text-center text-[.72em] text-muted">{{
                    monthLabel(a.month)
                  }}</span>
                </li>
              }
            </ul>

            <h3 class="mt-4 mb-2 text-[1em] font-semibold">
              {{ 'dialogs.repoStats.contributors' | t }}
            </h3>
            <ul class="m-0 list-none p-0">
              @for (p of s.contributors; track p.email + p.name) {
                <li class="border-b border-line py-1.5">
                  <div class="flex items-baseline gap-2">
                    <span class="truncate font-medium text-fg">{{ p.name }}</span>
                    <span class="mono min-w-0 flex-1 truncate text-[.86em] text-muted">{{
                      p.email
                    }}</span>
                    <span class="flex-none text-[.9em] text-muted">
                      {{ 'dialogs.repoStats.commitCount' | t: { n: p.commits } }}
                    </span>
                  </div>
                  <div class="mt-1 h-1.5 overflow-hidden rounded-full bg-input" aria-hidden="true">
                    <div
                      class="h-full rounded-full bg-accent"
                      [style.width.%]="width(p.commits)"
                    ></div>
                  </div>
                </li>
              }
            </ul>
          }
        }
      </div>
    </div>
  `,
})
export class RepoStatsDialog {
  readonly data = inject(DIALOG_DATA) as { store: RepositoryStore };
  readonly ref = inject(DIALOG_REF) as DialogRef;
  private readonly bridge = inject(BridgeService);
  private readonly i18n = inject(I18n);

  readonly stats = signal<RepoStats | null>(null);
  readonly loading = signal(true);
  readonly error = signal('');

  private readonly topCommits = computed(() => this.stats()?.contributors[0]?.commits ?? 0);
  private readonly maxActivity = computed(() =>
    Math.max(0, ...(this.stats()?.activity ?? []).map((a) => a.commits)),
  );

  readonly cards = computed(() => {
    const s = this.stats();
    if (!s) return [];
    const locale = this.i18n.locale();
    const nf = new Intl.NumberFormat(locale);
    const date = (iso: string | null) => (iso ? this.i18n.date(iso) : '-');
    return [
      { label: 'dialogs.repoStats.commits', value: nf.format(s.commits) },
      { label: 'dialogs.repoStats.branches', value: nf.format(s.branches) },
      { label: 'dialogs.repoStats.tags', value: nf.format(s.tags) },
      { label: 'dialogs.repoStats.files', value: nf.format(s.files) },
      { label: 'dialogs.repoStats.size', value: formatKib(s.sizeKb, locale) },
      { label: 'dialogs.repoStats.firstCommit', value: date(s.firstCommit) },
      { label: 'dialogs.repoStats.lastCommit', value: date(s.lastCommit) },
    ];
  });

  constructor() {
    this.bridge
      .git('repoStats', this.data.store.path())
      .then((s) => this.stats.set(s))
      .catch((e: unknown) => this.error.set(e instanceof Error ? e.message : String(e)))
      .finally(() => this.loading.set(false));
  }

  width(commits: number): number {
    return barWidth(commits, this.topCommits());
  }

  barH(commits: number): number {
    return barWidth(commits, this.maxActivity());
  }

  max(a: number, b: number): number {
    return Math.max(a, b);
  }

  monthLabel(month: string): string {
    return shortMonth(month, this.i18n.locale());
  }
}

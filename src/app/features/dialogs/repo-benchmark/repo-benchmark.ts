import { Component, computed, inject, signal } from '@angular/core';

import { TPipe } from '@core/i18n/i18n';
import { BenchmarkResult } from '@core/models';
import { BridgeService, DIALOG_DATA, DIALOG_REF, DialogRef } from '@core/services';
import { RepositoryStore } from '@core/store';
import { Icon } from '@shared/components';

import { barClass, barPercent, totalMs } from './repo-benchmark.logic';

@Component({
  imports: [TPipe, Icon],
  selector: 'gt-repo-benchmark',
  template: `
    <div class="dialog">
      <header class="dialog-head">
        <h2>{{ 'dialogs.benchmark.title' | t }}</h2>
        <button class="icon-btn" [attr.aria-label]="'common.close' | t" (click)="ref.close()">
          <gt-icon name="x" />
        </button>
      </header>
      <div class="dialog-body flex flex-col gap-3">
        <p class="muted m-0">{{ 'dialogs.benchmark.hint' | t }}</p>
        <div aria-live="polite">
          @if (running()) {
            <p class="m-0 flex items-center gap-2 text-muted">
              <span class="spinner"></span>{{ 'dialogs.benchmark.running' | t }}
            </p>
          }
          @if (error(); as msg) {
            <p class="m-0 text-danger" role="alert">{{ msg }}</p>
          }
          @if (results(); as list) {
            <ul class="m-0 list-none rounded-md border border-line bg-surface-2 p-0">
              @for (r of list; track r.name) {
                <li
                  class="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 border-b border-line px-3 py-2"
                >
                  <div class="min-w-0">
                    <div class="truncate">{{ r.name | t }}</div>
                    <div class="mono truncate text-[.86em] text-muted">{{ r.command }}</div>
                  </div>
                  @if (r.ms === null) {
                    <span class="text-danger">{{ 'dialogs.benchmark.failed' | t }}</span>
                  } @else {
                    <span class="mono">
                      {{ 'dialogs.benchmark.ms' | t: { ms: round(r.ms) } }}
                    </span>
                  }
                  <div
                    class="col-span-2 h-1.5 overflow-hidden rounded-full bg-input"
                    role="img"
                    [attr.aria-label]="label(r)"
                  >
                    <div
                      class="h-full rounded-full"
                      [class]="color(r)"
                      [style.width.%]="percent(r, list)"
                    ></div>
                  </div>
                </li>
              }
              <li class="flex items-center justify-between px-3 py-2 font-semibold">
                <span>{{ 'dialogs.benchmark.total' | t }}</span>
                <span class="mono">
                  {{ 'dialogs.benchmark.ms' | t: { ms: round(total()) } }}
                </span>
              </li>
            </ul>
          }
        </div>
      </div>
      <footer class="dialog-foot">
        <button class="btn" (click)="ref.close()">{{ 'common.close' | t }}</button>
        <button class="btn primary" [disabled]="running()" (click)="run()">
          <gt-icon [name]="results() ? 'refresh' : 'play'" />
          {{ (results() ? 'dialogs.benchmark.rerun' : 'dialogs.benchmark.run') | t }}
        </button>
      </footer>
    </div>
  `,
})
export class RepoBenchmarkDialog {
  readonly data = inject(DIALOG_DATA) as { store: RepositoryStore };
  readonly ref = inject(DIALOG_REF) as DialogRef;
  private readonly bridge = inject(BridgeService);

  readonly results = signal<BenchmarkResult[] | null>(null);
  readonly running = signal(false);
  readonly error = signal<string | null>(null);
  readonly total = computed(() => totalMs(this.results() ?? []));

  async run() {
    if (this.running()) return;
    this.running.set(true);
    this.error.set(null);
    try {
      this.results.set(await this.bridge.git('benchmark', this.data.store.path()));
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.running.set(false);
    }
  }

  round(ms: number): number {
    return Math.round(ms);
  }

  percent(r: BenchmarkResult, list: readonly BenchmarkResult[]): number {
    return barPercent(r.ms, list);
  }

  color(r: BenchmarkResult): string {
    return barClass(r.ms);
  }

  label(r: BenchmarkResult): string {
    return `${r.command}: ${r.ms === null ? '-' : Math.round(r.ms) + ' ms'}`;
  }
}

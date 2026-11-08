import { Component, computed, inject, signal } from '@angular/core';

import { I18n, TPipe } from '@core/i18n/i18n';
import { BridgeService, DIALOG_DATA, DIALOG_REF, DialogRef } from '@core/services';
import { RepositoryStore } from '@core/store';
import { Icon } from '@shared/components';

import { layoutTreemap } from './treemap-layout';
import { TreeEntry, TreeNode, buildTree, childrenAt, formatBytes } from './treemap-tree';

/** Dimensiones nominales de la caja, solo para calcular proporciones. */
const BOX_W = 760;
const BOX_H = 420;
/** Entradas por debajo de esta fraccion de la carpeta no se dibujan (si cuentan en los totales). */
const MIN_FRACTION = 0.005;
/** Tamano minimo en px para mostrar texto dentro de un bloque. */
const MIN_TEXT_W = 72;
const MIN_TEXT_H = 36;

interface Block {
  entry: TreeEntry;
  left: number;
  top: number;
  width: number;
  height: number;
  lane: number;
  showText: boolean;
  label: string;
}

@Component({
  imports: [TPipe, Icon],
  selector: 'gt-repo-treemap',
  template: `
    <div class="dialog">
      <header class="dialog-head">
        <h2>{{ 'dialogs.treemap.title' | t }}</h2>
        <button class="icon-btn" [attr.aria-label]="'common.close' | t" (click)="ref.close()">
          <gt-icon name="x" />
        </button>
      </header>
      <div class="dialog-body">
        @if (loading()) {
          <p class="muted flex items-center gap-2">
            <span class="spinner"></span>{{ 'app.loading' | t }}
          </p>
        } @else if (error()) {
          <p role="alert" class="text-danger">{{ error() }}</p>
        } @else if (totalFiles() === 0) {
          <p class="muted">{{ 'dialogs.treemap.empty' | t }}</p>
        } @else {
          <div class="mb-2 flex items-center gap-2">
            <button
              class="icon-btn"
              [disabled]="path().length === 0"
              [attr.aria-label]="'dialogs.treemap.up' | t"
              [title]="'dialogs.treemap.up' | t"
              (click)="up()"
            >
              <gt-icon name="chevron-down" class="inline-block rotate-90" />
            </button>
            <nav class="mono flex min-w-0 flex-wrap items-center gap-1 text-[.9em]">
              <button class="btn tiny" (click)="goTo(0)">{{ 'dialogs.treemap.root' | t }}</button>
              @for (seg of path(); track $index) {
                <span class="text-faint" aria-hidden="true">/</span>
                <button class="btn tiny" (click)="goTo($index + 1)">{{ seg }}</button>
              }
            </nav>
            <span class="muted ml-auto whitespace-nowrap text-[.9em]">
              {{ 'dialogs.treemap.total' | t: { size: fmt(total()) } }} ·
              {{ 'dialogs.treemap.fileCount' | t: { n: fileCount() } }}
            </span>
          </div>
          <div
            class="relative h-[420px] w-full overflow-hidden rounded border border-line bg-surface-2"
          >
            @for (b of blocks(); track b.entry.name) {
              @if (b.entry.isDir) {
                <button
                  type="button"
                  class="absolute cursor-pointer overflow-hidden border border-surface p-1 text-left text-on-lane hover:brightness-110 focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-fg"
                  [class]="laneClass(b.lane)"
                  [style.left.%]="b.left"
                  [style.top.%]="b.top"
                  [style.width.%]="b.width"
                  [style.height.%]="b.height"
                  [title]="b.label"
                  [attr.aria-label]="b.label"
                  (click)="open(b.entry)"
                >
                  @if (b.showText) {
                    <span class="flex items-center gap-1 text-[.85em] font-semibold">
                      <gt-icon name="folder" /><span class="truncate">{{ b.entry.name }}</span>
                    </span>
                    <span class="block text-[.8em]">{{ fmt(b.entry.size) }}</span>
                  }
                </button>
              } @else {
                <div
                  role="img"
                  class="absolute overflow-hidden border border-surface bg-surface p-1 text-fg"
                  [style.left.%]="b.left"
                  [style.top.%]="b.top"
                  [style.width.%]="b.width"
                  [style.height.%]="b.height"
                  [title]="b.label"
                  [attr.aria-label]="b.label"
                >
                  @if (b.showText) {
                    <span class="block truncate text-[.85em] font-semibold">{{
                      b.entry.name
                    }}</span>
                    <span class="muted block text-[.8em]">{{ fmt(b.entry.size) }}</span>
                  }
                </div>
              }
            }
          </div>
          <p class="muted mt-2 text-[.88em]">{{ 'dialogs.treemap.hint' | t }}</p>
        }
      </div>
    </div>
  `,
})
export class RepoTreemapDialog {
  readonly data = inject(DIALOG_DATA) as { store: RepositoryStore };
  readonly ref = inject(DIALOG_REF) as DialogRef;
  private readonly bridge = inject(BridgeService);
  private readonly i18n = inject(I18n);

  readonly loading = signal(true);
  readonly error = signal('');
  readonly path = signal<string[]>([]);
  private readonly root = signal<TreeNode | null>(null);

  readonly entries = computed(() => {
    const r = this.root();
    return r ? childrenAt(r, this.path()) : [];
  });
  readonly total = computed(() => this.entries().reduce((s, e) => s + e.size, 0));
  readonly fileCount = computed(() => this.entries().reduce((s, e) => s + e.fileCount, 0));
  readonly totalFiles = computed(() => this.root()?.fileCount ?? 0);

  readonly blocks = computed<Block[]>(() => {
    const total = this.total();
    const drawn = this.entries().filter((e) => e.size > 0 && e.size >= total * MIN_FRACTION);
    const rects = layoutTreemap(
      drawn.map((e) => ({ id: e.name, value: e.size })),
      BOX_W,
      BOX_H,
    );
    const byName = new Map(drawn.map((e) => [e.name, e]));
    return rects.map((r, i) => {
      const entry = byName.get(r.id)!;
      return {
        entry,
        left: (r.x / BOX_W) * 100,
        top: (r.y / BOX_H) * 100,
        width: (r.w / BOX_W) * 100,
        height: (r.h / BOX_H) * 100,
        lane: i % 8,
        showText: r.w >= MIN_TEXT_W && r.h >= MIN_TEXT_H,
        label: `${entry.name}, ${this.fmt(entry.size)}, ${this.i18n.t('dialogs.treemap.fileCount', { n: entry.fileCount })}`,
      };
    });
  });

  constructor() {
    this.bridge
      .git('fileSizes', this.data.store.path())
      .then((files) => this.root.set(buildTree(files)))
      .catch((e: unknown) => this.error.set(e instanceof Error ? e.message : String(e)))
      .finally(() => this.loading.set(false));
  }

  fmt(n: number): string {
    return formatBytes(n, this.i18n.locale());
  }

  laneClass(i: number): string {
    return LANES[i] ?? LANES[0];
  }

  open(e: TreeEntry) {
    if (e.isDir) this.path.update((p) => [...p, e.name]);
  }

  up() {
    this.path.update((p) => p.slice(0, -1));
  }

  goTo(depth: number) {
    this.path.update((p) => p.slice(0, depth));
  }
}

/** Clases literales para que Tailwind las detecte. */
const LANES = [
  'bg-(--lane-0)',
  'bg-(--lane-1)',
  'bg-(--lane-2)',
  'bg-(--lane-3)',
  'bg-(--lane-4)',
  'bg-(--lane-5)',
  'bg-(--lane-6)',
  'bg-(--lane-7)',
];

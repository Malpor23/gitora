import { Component, computed, inject, signal } from '@angular/core';

import { TPipe } from '@core/i18n/i18n';
import { DIALOG_DATA, DIALOG_REF, DialogRef } from '@core/services';
import { Icon } from '@shared/components';

export type PathPickRequest =
  | { mode: 'directory'; title: string }
  | { mode: 'files'; title: string }
  | { mode: 'save'; title: string; defaultName: string };

/** Carpeta → string; archivos → string[]; guardar como → string. */
export type PathPickResult = string | string[];

interface Entry {
  name: string;
  kind: 'dir' | 'file';
  isRepo: boolean;
}

interface Listing {
  path: string;
  parent: string | null;
  isRepo: boolean;
  entries: Entry[];
}

/**
 * Selector de rutas del modo web (desarrollo): el navegador no tiene los diálogos nativos de
 * Electron (carpeta, archivos, guardar como), así que se navega el disco del servidor de
 * desarrollo desde un modal propio.
 */
@Component({
  imports: [TPipe, Icon],
  selector: 'gt-path-picker',
  template: `
    <form class="dialog" (submit)="$event.preventDefault(); choose()">
      <header class="dialog-head">
        <h2>{{ data.title }}</h2>
        <button
          type="button"
          class="icon-btn"
          [attr.aria-label]="'common.close' | t"
          (click)="ref.close()"
        >
          <gt-icon name="x" />
        </button>
      </header>
      <div class="dialog-body flex flex-col gap-2">
        <div class="flex gap-2">
          <button
            type="button"
            class="btn"
            [disabled]="!listing()?.parent"
            [attr.aria-label]="'dialogs.pathPicker.up' | t"
            [title]="'dialogs.pathPicker.up' | t"
            (click)="go(listing()?.parent)"
          >
            <gt-icon name="chevron-down" class="rotate-180" [size]="14" />
          </button>
          <input
            #pathInput
            type="text"
            class="mono"
            spellcheck="false"
            [attr.aria-label]="'dialogs.pathPicker.path' | t"
            [value]="draft()"
            (input)="draft.set(pathInput.value)"
            (keydown.enter)="$event.preventDefault(); go(draft())"
          />
        </div>
        @if (error(); as err) {
          <p class="error-text m-0" role="alert">{{ err }}</p>
        }
        <ul
          class="m-0 h-[320px] list-none overflow-auto rounded-md border border-line bg-input p-1"
          role="listbox"
          [attr.aria-multiselectable]="mode === 'files'"
          [attr.aria-label]="'dialogs.pathPicker.items' | t"
        >
          @for (e of listing()?.entries ?? []; track e.name) {
            <li role="option" [attr.aria-selected]="isSelected(e)">
              <button
                type="button"
                class="flex w-full cursor-pointer items-center gap-2 rounded-sm border-0 px-2 py-1 text-left hover:bg-hover"
                [class]="isSelected(e) ? 'bg-selected' : 'bg-transparent'"
                (click)="open(e)"
              >
                <gt-icon
                  [name]="
                    e.kind === 'file'
                      ? isSelected(e)
                        ? 'check'
                        : 'file'
                      : e.isRepo
                        ? 'git-branch'
                        : 'folder'
                  "
                  [size]="14"
                />
                <span class="min-w-0 flex-1 truncate">{{ e.name }}</span>
                @if (e.isRepo) {
                  <span class="rounded-sm bg-accent-soft px-1.5 text-[.8em] text-accent-fg"
                    >git</span
                  >
                }
              </button>
            </li>
          } @empty {
            @if (!loading()) {
              <li class="px-2 py-1 text-muted" role="presentation">
                {{ 'dialogs.pathPicker.empty' | t }}
              </li>
            }
          }
        </ul>
        @if (mode === 'save') {
          <div>
            <label for="path-picker-name">{{ 'dialogs.pathPicker.fileName' | t }}</label>
            <input
              id="path-picker-name"
              #nameInput
              type="text"
              class="mono"
              spellcheck="false"
              [value]="fileName()"
              (input)="fileName.set(nameInput.value)"
            />
            @if (willReplace()) {
              <p class="hint">{{ 'dialogs.pathPicker.willReplace' | t }}</p>
            }
          </div>
        }
      </div>
      <footer class="dialog-foot">
        <button type="button" class="btn ghost" (click)="ref.close()">
          {{ 'common.cancel' | t }}
        </button>
        <button type="submit" class="btn primary" [disabled]="!canChoose()">
          {{ confirmLabel() | t: { n: selected().size } }}
        </button>
      </footer>
    </form>
  `,
})
export class PathPicker {
  readonly data = inject(DIALOG_DATA) as PathPickRequest;
  readonly ref = inject(DIALOG_REF) as DialogRef<PathPickResult>;
  readonly mode = this.data.mode;

  readonly listing = signal<Listing | null>(null);
  readonly draft = signal('');
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly selected = signal<ReadonlySet<string>>(new Set());
  readonly fileName = signal(this.data.mode === 'save' ? this.data.defaultName : '');

  private readonly validName = computed(() => {
    const n = this.fileName().trim();
    return n !== '' && n !== '.' && n !== '..' && !/[\\/]/.test(n);
  });

  readonly willReplace = computed(
    () =>
      this.mode === 'save' &&
      !!this.listing()?.entries.some((e) => e.kind === 'file' && e.name === this.fileName().trim()),
  );

  readonly canChoose = computed(() => {
    if (this.mode === 'files') return this.selected().size > 0;
    if (this.mode === 'save') return !!this.listing() && this.validName();
    return !!this.listing();
  });

  readonly confirmLabel = computed(() =>
    this.mode === 'files'
      ? 'dialogs.pathPicker.chooseFiles'
      : this.mode === 'save'
        ? 'dialogs.pathPicker.save'
        : 'dialogs.pathPicker.chooseFolder',
  );

  constructor() {
    void this.go('');
  }

  private join(name: string): string {
    const base = this.listing()?.path ?? '';
    return base.endsWith('/') ? base + name : `${base}/${name}`;
  }

  isSelected(e: Entry): boolean {
    if (e.kind !== 'file') return false;
    if (this.mode === 'files') return this.selected().has(this.join(e.name));
    return this.mode === 'save' && this.fileName().trim() === e.name;
  }

  /** Carpeta: entra. Archivo: lo marca (varios) o lo usa como nombre (guardar como). */
  open(e: Entry) {
    if (e.kind === 'dir') {
      void this.go(this.join(e.name));
    } else if (this.mode === 'files') {
      const path = this.join(e.name);
      this.selected.update((s) => {
        const next = new Set(s);
        if (!next.delete(path)) next.add(path);
        return next;
      });
    } else if (this.mode === 'save') {
      this.fileName.set(e.name);
    }
  }

  async go(target?: string | null) {
    this.loading.set(true);
    this.error.set(null);
    try {
      const res = await fetch('/api/fs/list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ args: [target ?? '', this.mode !== 'directory'] }),
      });
      const body = (await res.json().catch(() => ({}))) as { result?: Listing; message?: string };
      if (!res.ok || !body.result) throw new Error(body.message ?? `Error ${res.status}`);
      this.listing.set(body.result);
      this.draft.set(body.result.path);
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.loading.set(false);
    }
  }

  choose() {
    if (!this.canChoose()) return;
    if (this.mode === 'files') this.ref.close([...this.selected()]);
    else if (this.mode === 'save') this.ref.close(this.join(this.fileName().trim()));
    else this.ref.close(this.listing()?.path);
  }
}

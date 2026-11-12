import { Component, computed, effect, input, output, signal } from '@angular/core';

import { TPipe } from '@core/i18n/i18n';
import { DiffFile, DiffHunk, DiffLine } from '@core/models';
import { imageMime } from '../../../../shared/image';
import { Icon } from '@shared/components';
import { ImageDiff, ImageRef } from './image-diff/image-diff';

/** De dónde sale el diff, para poder pedir las dos versiones de una imagen. */
export type DiffSource =
  | { repo: string; kind: 'working'; staged: boolean }
  | { repo: string; kind: 'commit'; hash: string };

export type HunkMode = 'stage' | 'unstage' | 'discard';

export interface HunkActionEvent {
  mode: HunkMode;
  hunkIndex: number;
  /** Índices de líneas dentro del hunk; null = hunk completo. */
  lines: number[] | null;
}

interface SplitRow {
  left: (DiffLine & { idx: number }) | null;
  right: (DiffLine & { idx: number }) | null;
}

const LARGE = 4000;

@Component({
  imports: [Icon, ImageDiff, TPipe],
  selector: 'gt-diff-viewer',
  host: { class: 'flex flex-col min-h-0 h-full' },
  templateUrl: './diff-viewer.html',
})
export class DiffViewer {
  readonly file = input<DiffFile | null>(null);
  readonly mode = input<'unified' | 'split'>('unified');
  readonly actions = input<'stage' | 'unstage' | 'none'>('none');
  readonly emptyText = input('');
  /** Origen del diff; sin él los archivos binarios no pueden mostrar su vista previa. */
  readonly source = input<DiffSource | null>(null);
  readonly hunkAction = output<HunkActionEvent>();
  readonly modeChange = output<'unified' | 'split'>();

  readonly forceShow = signal(false);
  private readonly selection = signal<{ hunk: number; lines: Set<number> } | null>(null);
  private anchor: { hunk: number; line: number } | null = null;

  readonly lineCount = computed(
    () => this.file()?.hunks.reduce((n, h) => n + h.lines.length, 0) ?? 0,
  );
  readonly tooLarge = computed(() => this.lineCount() > LARGE);
  readonly selectedCount = computed(() => this.selection()?.lines.size ?? 0);
  /** Versiones anterior y nueva cuando el archivo binario es una imagen soportada. */
  readonly imageRefs = computed<{ before: ImageRef | null; after: ImageRef | null } | null>(() => {
    const f = this.file();
    const src = this.source();
    if (!f?.isBinary || !src || !imageMime(f.isDeleted ? f.oldPath : f.newPath)) return null;
    const before = (rev: string | null): ImageRef | null =>
      f.isNew ? null : { rev, path: f.oldPath };
    const after = (rev: string | null): ImageRef | null =>
      f.isDeleted ? null : { rev, path: f.newPath };
    if (src.kind === 'commit') return { before: before(`${src.hash}^`), after: after(src.hash) };
    return src.staged
      ? { before: before('HEAD'), after: after('') }
      : { before: before(''), after: after(null) };
  });
  readonly splitRows = computed(() => (this.file()?.hunks ?? []).map((h) => toSplit(h)));

  constructor() {
    // Al cambiar de archivo se limpia la selección
    effect(() => {
      this.file();
      this.selection.set(null);
      this.forceShow.set(false);
      this.anchor = null;
    });
  }

  sign(l: DiffLine) {
    return l.type === 'add' ? '+' : l.type === 'del' ? '−' : l.type === 'nonewline' ? '⏎' : ' ';
  }

  isSelected(hunk: number, line: number): boolean {
    const s = this.selection();
    return !!s && s.hunk === hunk && s.lines.has(line);
  }

  toggle(e: MouseEvent, hunk: number, line: number, l: DiffLine) {
    if (this.actions() === 'none' || (l.type !== 'add' && l.type !== 'del')) return;
    e.preventDefault();
    const current = this.selection();
    const lines = current && current.hunk === hunk ? new Set(current.lines) : new Set<number>();
    if (e.shiftKey && this.anchor && this.anchor.hunk === hunk) {
      const [a, b] = [this.anchor.line, line].sort((x, y) => x - y);
      const hunkLines = this.file()!.hunks[hunk].lines;
      for (let i = a; i <= b; i++)
        if (hunkLines[i].type === 'add' || hunkLines[i].type === 'del') lines.add(i);
    } else {
      if (lines.has(line)) lines.delete(line);
      else lines.add(line);
      this.anchor = { hunk, line };
    }
    this.selection.set(lines.size ? { hunk, lines } : null);
  }

  emitLines(mode: HunkMode) {
    const s = this.selection();
    if (!s) return;
    this.hunkAction.emit({ mode, hunkIndex: s.hunk, lines: [...s.lines].sort((a, b) => a - b) });
    this.selection.set(null);
  }
}

/** Empareja bloques de líneas eliminadas/añadidas para la vista lado a lado. */
function toSplit(h: DiffHunk): SplitRow[] {
  const rows: SplitRow[] = [];
  let dels: (DiffLine & { idx: number })[] = [];
  let adds: (DiffLine & { idx: number })[] = [];
  const flush = () => {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) rows.push({ left: dels[i] ?? null, right: adds[i] ?? null });
    dels = [];
    adds = [];
  };
  h.lines.forEach((l, idx) => {
    const line = { ...l, idx };
    if (l.type === 'del') {
      if (adds.length) flush();
      dels.push(line);
    } else if (l.type === 'add') {
      adds.push(line);
    } else {
      flush();
      if (l.type === 'ctx') rows.push({ left: line, right: line });
    }
  });
  flush();
  return rows;
}

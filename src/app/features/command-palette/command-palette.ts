import {
  afterNextRender,
  Component,
  computed,
  ElementRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';

import { I18n, TPipe } from '@core/i18n/i18n';
import { DIALOG_REF, DialogRef, WorkspaceService } from '@core/services';
import { Command, Commands } from '@features/actions';
import { Icon } from '@shared/components';

interface Row {
  category?: string;
  item?: Scored;
  index?: number;
}

interface Scored {
  cmd: Command;
  label: string;
  score: number;
}

@Component({
  imports: [TPipe, Icon],
  selector: 'gt-command-palette',
  templateUrl: './command-palette.html',
})
export class CommandPalette {
  readonly ref = inject(DIALOG_REF) as DialogRef;
  private readonly commands = inject(Commands);
  private readonly ws = inject(WorkspaceService);
  private readonly i18n = inject(I18n);
  private readonly input = viewChild<ElementRef<HTMLInputElement>>('input');

  readonly query = signal('');
  readonly index = signal(0);

  readonly results = computed<Scored[]>(() => {
    this.i18n.lang();
    const q = normalize(this.query().trim());
    const list = this.commands.available(this.ws.active()).map((cmd) => {
      const label = this.i18n.t(cmd.label);
      return { cmd, label, score: q ? score(q, normalize(label), normalize(cmd.git ?? '')) : 1 };
    });
    const filtered = list.filter((r) => r.score > 0);
    // Con búsqueda: por relevancia. Sin búsqueda: agrupado por categoría.
    return q ? filtered.sort((a, b) => b.score - a.score) : filtered;
  });

  /** Filas a pintar: con búsqueda solo comandos; sin ella, con cabeceras por categoría. */
  readonly rows = computed<Row[]>(() => {
    const grouped = !this.query().trim();
    const rows: Row[] = [];
    let last = '';
    this.results().forEach((item, index) => {
      if (grouped && item.cmd.category !== last) {
        last = item.cmd.category;
        rows.push({ category: last });
      }
      rows.push({ item, index });
    });
    return rows;
  });

  constructor() {
    afterNextRender(() => this.input()?.nativeElement.focus());
  }

  onQuery(value: string) {
    this.query.set(value);
    this.index.set(0);
  }

  /** Chromium emite mousemove sintéticos al cambiar el layout bajo un cursor quieto: se ignoran. */
  onHover(e: MouseEvent, i: number) {
    if (e.movementX || e.movementY) this.index.set(i);
  }

  onKey(e: KeyboardEvent) {
    const n = this.results().length;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.index.update((i) => (i + 1) % Math.max(n, 1));
      this.scroll();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.index.update((i) => (i - 1 + n) % Math.max(n, 1));
      this.scroll();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const r = this.results()[this.index()];
      if (r) this.run(r.cmd);
    }
  }

  private scroll() {
    queueMicrotask(() =>
      document.querySelector('.palette li.active')?.scrollIntoView({ block: 'nearest' }),
    );
  }

  run(cmd: Command) {
    this.ref.close();
    void cmd.run(this.ws.active());
  }
}

function normalize(s: string) {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Puntuación simple: coincidencia al inicio > palabra > subcadena > letras en orden. */
function score(q: string, label: string, git: string): number {
  if (label.startsWith(q)) return 100;
  if (label.split(/\s+/).some((w) => w.startsWith(q))) return 80;
  if (label.includes(q)) return 60;
  if (git.includes(q)) return 50;
  let i = 0;
  for (const ch of label) if (ch === q[i]) i++;
  return i === q.length ? 20 : 0;
}

import { afterNextRender, Component, ElementRef, inject, signal, viewChild } from '@angular/core';

import { TPipe } from '@core/i18n/i18n';
import { BridgeService, DIALOG_DATA, DIALOG_REF, DialogRef } from '@core/services';
import { RepositoryStore } from '@core/store';
import { Icon } from '@shared/components';

@Component({
  imports: [TPipe, Icon],
  selector: 'gt-custom-command',
  templateUrl: './custom-command.html',
})
export class CustomCommand {
  readonly data = inject(DIALOG_DATA) as { store: RepositoryStore };
  readonly ref = inject(DIALOG_REF) as DialogRef;
  private readonly bridge = inject(BridgeService);
  private readonly input = viewChild<ElementRef<HTMLInputElement>>('input');

  readonly command = signal('');
  readonly output = signal('');
  readonly running = signal(false);
  readonly isError = signal(false);
  private past: string[] = [];
  private cursor = -1;

  constructor() {
    afterNextRender(() => this.input()?.nativeElement.focus());
  }

  async run() {
    const cmd = this.command().trim();
    if (!cmd) return;
    this.past.unshift(cmd);
    this.cursor = -1;
    this.running.set(true);
    try {
      const out = await this.bridge.git('raw', this.data.store.path(), splitArgs(cmd));
      this.output.set(out || '✓');
      this.isError.set(false);
    } catch (e) {
      this.output.set(e instanceof Error ? e.message : String(e));
      this.isError.set(true);
    } finally {
      this.running.set(false);
      void this.data.store.refresh();
    }
  }

  history(e: KeyboardEvent) {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    this.cursor = Math.max(
      -1,
      Math.min(this.past.length - 1, this.cursor + (e.key === 'ArrowUp' ? 1 : -1)),
    );
    this.command.set(this.cursor === -1 ? '' : this.past[this.cursor]);
  }
}

/** Separa argumentos respetando comillas simples y dobles. */
export function splitArgs(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let has = false;
  for (const ch of s.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (cur || has) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += ch;
    }
  }
  if (cur || has) out.push(cur);
  return out[0] === 'git' ? out.slice(1) : out;
}

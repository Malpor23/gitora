import { Component, effect, ElementRef, inject, signal, viewChild } from '@angular/core';

import { TPipe } from '@core/i18n/i18n';
import { BridgeService, WorkspaceService } from '@core/services';
import { splitArgs } from '@features/dialogs';
import { Icon } from '@shared/components';

@Component({
  imports: [TPipe, Icon],
  selector: 'gt-console-panel',
  host: { class: 'block h-full' },
  templateUrl: './console-panel.html',
})
export class ConsolePanel {
  readonly ws = inject(WorkspaceService);
  private readonly bridge = inject(BridgeService);
  private readonly logEl = viewChild<ElementRef<HTMLElement>>('log');
  readonly cmd = signal('');

  constructor() {
    // Mantener la consola desplazada al final cuando llegan comandos nuevos
    effect(() => {
      this.ws.commandLog();
      const el = this.logEl()?.nativeElement;
      if (el) queueMicrotask(() => (el.scrollTop = el.scrollHeight));
    });
  }

  async run() {
    const s = this.ws.active();
    const text = this.cmd().trim();
    if (!s || !text) return;
    this.cmd.set('');
    await this.bridge.git('raw', s.path(), splitArgs(text)).catch(() => undefined);
    void s.refresh();
  }
}

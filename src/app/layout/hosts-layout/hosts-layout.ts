import { NgComponentOutlet } from '@angular/common';
import {
  afterRenderEffect,
  Component,
  ElementRef,
  inject,
  viewChild,
} from '@angular/core';

import { ContextMenuService, DialogService, NotifyService } from '@core/services';
import { Icon } from '@shared/components';

@Component({
  imports: [NgComponentOutlet, Icon],
  selector: 'gt-hosts-layout',
  templateUrl: './hosts-layout.html',
})
export class HostsLayout {
  readonly dialogs = inject(DialogService);
  readonly menu = inject(ContextMenuService);
  readonly notify = inject(NotifyService);
  private readonly menuEl = viewChild<ElementRef<HTMLElement>>('menuEl');

  constructor() {
    // Mantener el menú contextual dentro de la ventana
    afterRenderEffect(() => {
      const el = this.menuEl()?.nativeElement;
      const state = this.menu.state();
      if (!el || !state) return;
      const r = el.getBoundingClientRect();
      if (r.right > window.innerWidth - 4)
        el.style.left = `${Math.max(4, window.innerWidth - r.width - 4)}px`;
      if (r.bottom > window.innerHeight - 4)
        el.style.top = `${Math.max(4, window.innerHeight - r.height - 4)}px`;
    });
  }

  pick(action?: () => unknown) {
    this.menu.close();
    if (action) void action();
  }
}

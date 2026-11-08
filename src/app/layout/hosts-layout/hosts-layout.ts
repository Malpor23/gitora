import { NgComponentOutlet } from '@angular/common';
import {
  afterRenderEffect,
  Component,
  ElementRef,
  inject,
  viewChild,
} from '@angular/core';

import { ContextMenuService, DialogService, MenuItem, NotifyService } from '@core/services';
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

  /*
   * Los manejadores de eventos de la plantilla NO deben devolver `false`: Angular llama entonces a
   * `preventDefault()`. Con `target === currentTarget && ...` un clic dentro del diálogo evaluaba a
   * `false` y cancelaba la acción nativa del mousedown (arrastrar sliders, enfocar campos, seleccionar
   * texto). Por eso estos métodos no devuelven nada.
   */
  closeOnBackdrop(e: MouseEvent) {
    if (e.target === e.currentTarget) this.dialogs.closeTop();
  }

  /** Mantiene Tab / Shift+Tab dentro del diálogo modal (WCAG 2.1.2 / 2.4.3). */
  trapFocus(e: KeyboardEvent) {
    if (e.key !== 'Tab') return;
    const box = e.currentTarget as HTMLElement;
    const items = Array.from(
      box.querySelectorAll<HTMLElement>(
        'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => !(el as HTMLButtonElement).disabled && el.tabIndex >= 0 && el.offsetParent !== null);
    if (!items.length) {
      e.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !box.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !box.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  }

  dismissToast(t: { id: number; kind: string }) {
    if (t.kind !== 'progress') this.notify.dismiss(t.id);
  }

  pickEnabled(it: MenuItem) {
    if (!it.disabled) this.pick(it.action);
  }
}

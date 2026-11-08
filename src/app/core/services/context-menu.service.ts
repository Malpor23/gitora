import { Service, signal } from '@angular/core';

export interface MenuItem {
  label?: string;
  icon?: string;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
  header?: boolean; // título de sección no interactivo
  action?: () => unknown;
}

export interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

@Service()
export class ContextMenuService {
  readonly state = signal<MenuState | null>(null);

  open(event: MouseEvent, items: (MenuItem | false | null | undefined)[]) {
    event.preventDefault();
    event.stopPropagation();
    this.show(event.clientX, event.clientY, items);
  }

  /** Despliega el menú justo debajo de un elemento (botones con dropdown de la barra). */
  openAt(anchor: HTMLElement, items: (MenuItem | false | null | undefined)[]) {
    const r = anchor.getBoundingClientRect();
    this.show(r.left, r.bottom + 2, items);
  }

  private show(x: number, y: number, items: (MenuItem | false | null | undefined)[]) {
    const clean = items.filter((i): i is MenuItem => !!i);
    // Quitar separadores duplicados o en los extremos
    const compact = clean.filter(
      (it, i, arr) => !(it.separator && (i === 0 || i === arr.length - 1 || arr[i - 1].separator)),
    );
    this.state.set({ x, y, items: compact });
  }

  close() {
    this.state.set(null);
  }
}

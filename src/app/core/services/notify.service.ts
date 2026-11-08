import { inject, Service, signal } from '@angular/core';

import { I18n } from '@core/i18n';

export interface Toast {
  id: number;
  kind: 'success' | 'error' | 'info' | 'progress';
  text: string;
  detail?: string;
  percent?: number | null;
}

@Service()
export class NotifyService {
  private readonly i18n = inject(I18n);
  private seq = 0;
  readonly toasts = signal<Toast[]>([]);

  success(key: string, params?: Record<string, string | number>) {
    this.push({ kind: 'success', text: this.i18n.t(key, params) }, 3500);
  }

  info(text: string) {
    this.push({ kind: 'info', text }, 4000);
  }

  error(e: unknown) {
    const text = e instanceof Error ? e.message : String(e ?? this.i18n.t('common.unknownError'));
    this.push({ kind: 'error', text }, 9000);
  }

  /** Toast persistente con barra de progreso; devuelve funciones para actualizar/cerrar. */
  progress(text: string) {
    const id = this.push({ kind: 'progress', text, percent: null }, 0);
    return {
      update: (detail: string, percent: number | null) =>
        this.toasts.update((list) =>
          list.map((t) => (t.id === id ? { ...t, detail, percent } : t)),
        ),
      close: () => this.dismiss(id),
    };
  }

  dismiss(id: number) {
    this.toasts.update((list) => list.filter((t) => t.id !== id));
  }

  private push(t: Omit<Toast, 'id'>, ttl: number): number {
    const id = ++this.seq;
    this.toasts.update((list) => [...list.slice(-4), { ...t, id }]);
    if (ttl) setTimeout(() => this.dismiss(id), ttl);
    return id;
  }
}

import { inject, InjectionToken, Injector, Service, signal, Type } from '@angular/core';

import { I18n } from '@core/i18n';

export interface DialogRef<R = unknown> {
  close(result?: R): void;
}

export const DIALOG_REF = new InjectionToken<DialogRef>('DIALOG_REF');
export const DIALOG_DATA = new InjectionToken<unknown>('DIALOG_DATA');

interface OpenDialog {
  id: number;
  component: Type<unknown>;
  injector: Injector;
  width: number;
}

/**
 * Formulario genérico (la mayoría de comandos git son "rellena y ejecuta")
 */
export type FieldValue = string | number | boolean;
export type FormValues = Record<string, FieldValue>;

export interface FieldOption {
  value: string;
  label: string;
  hint?: string;
}

export interface FieldSpec {
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'select' | 'checkbox' | 'radio' | 'path' | 'number' | 'combo';
  value?: FieldValue;
  options?: FieldOption[];
  /** Opciones que dependen de los demás valores (p. ej. las ramas del remoto elegido). */
  optionsWhen?: (all: FormValues) => FieldOption[];
  /** Solo lectura: se muestra pero no se puede editar. */
  readonly?: boolean;
  /** Recalcula este campo cuando cambia alguno de los campos de `deps` (p. ej. el destino). */
  autoValue?: { deps: string[]; compute: (all: FormValues) => FieldValue };
  placeholder?: string;
  hint?: string;
  required?: boolean;
  mono?: boolean;
  autofocus?: boolean;
  validate?: (value: FieldValue, all: FormValues) => string | null;
  visibleWhen?: (all: FormValues) => boolean;
  /** Muestra una advertencia (no bloquea) según los valores. */
  warnWhen?: (all: FormValues) => string | null;
}

export interface FormDialogData {
  title: string;
  message?: string;
  fields: FieldSpec[];
  submitLabel?: string;
  danger?: boolean;
  width?: number;
  /** Se evalúa antes de `run`; si devuelve false no se ejecuta y el diálogo sigue abierto. */
  beforeRun?: (values: FormValues) => boolean | Promise<boolean>;
  /** Si se define, se ejecuta dentro del diálogo; si falla, el error se muestra ahí mismo. */
  run?: (values: FormValues) => Promise<unknown>;
}

@Service()
export class DialogService {
  private readonly injector = inject(Injector);
  private readonly i18n = inject(I18n);
  private seq = 0;
  readonly stack = signal<OpenDialog[]>([]);

  open<R = unknown, D = unknown>(
    component: Type<unknown>,
    data?: D,
    width = 520,
  ): Promise<R | undefined> {
    return new Promise((resolve) => {
      const id = ++this.seq;
      // Al cerrar, el foco vuelve al control que abrió el diálogo (WCAG 2.4.3)
      const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const ref: DialogRef<R> = {
        close: (result?: R) => {
          this.stack.update((s) => s.filter((d) => d.id !== id));
          if (opener && opener !== document.body) queueMicrotask(() => opener.isConnected && opener.focus());
          resolve(result);
        },
      };
      const injector = Injector.create({
        parent: this.injector,
        providers: [
          { provide: DIALOG_REF, useValue: ref },
          { provide: DIALOG_DATA, useValue: data },
        ],
      });
      this.stack.update((s) => [...s, { id, component, injector, width }]);
    });
  }

  closeTop() {
    const top = this.stack().at(-1);
    if (top) top.injector.get(DIALOG_REF).close(undefined);
  }

  async form(data: FormDialogData): Promise<FormValues | undefined> {
    const { FormDialog } = await import('@features/dialogs');
    return this.open<FormValues>(FormDialog, data, data.width ?? 520);
  }

  async confirm(
    message: string,
    opts: { title?: string; danger?: boolean; confirmLabel?: string } = {},
  ): Promise<boolean> {
    const r = await this.form({
      title: opts.title ?? this.i18n.t('common.confirm'),
      message,
      fields: [],
      danger: opts.danger,
      submitLabel: opts.confirmLabel ?? this.i18n.t('common.ok'),
      width: 440,
    });
    return !!r;
  }

  async prompt(
    title: string,
    label: string,
    value = '',
    mono = false,
  ): Promise<string | undefined> {
    const r = await this.form({
      title,
      fields: [{ key: 'v', label, type: 'text', value, required: true, autofocus: true, mono }],
      width: 460,
    });
    return r ? String(r['v']).trim() : undefined;
  }
}

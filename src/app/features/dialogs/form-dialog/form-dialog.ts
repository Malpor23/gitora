import { afterNextRender, Component, computed, ElementRef, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { I18n, TPipe } from '@core/i18n/i18n';
import {
  BridgeService,
  DIALOG_DATA,
  DIALOG_REF,
  DialogRef,
  FieldOption,
  FieldSpec,
  FieldValue,
  FormDialogData,
  FormValues,
} from '@core/services';
import { Icon } from '@shared/components';

@Component({
  imports: [FormsModule, TPipe, Icon],
  selector: 'gt-form-dialog',
  templateUrl: './form-dialog.html',
})
export class FormDialog {
  readonly data = inject(DIALOG_DATA) as FormDialogData;
  readonly ref = inject(DIALOG_REF) as DialogRef<FormValues>;
  private readonly bridge = inject(BridgeService);
  private readonly i18n = inject(I18n);
  private readonly el = inject(ElementRef<HTMLElement>);

  readonly values = signal<FormValues>(
    Object.fromEntries(
      this.data.fields.map((f) => [
        f.key,
        f.value ??
          (f.type === 'checkbox'
            ? false
            : f.type === 'radio' || f.type === 'select'
              ? (f.options?.[0]?.value ?? '')
              : ''),
      ]),
    ),
  );
  readonly touched = signal(false);
  readonly running = signal(false);
  readonly runError = signal<string | null>(null);
  readonly visibleFields = computed(() =>
    this.data.fields.filter((f) => !f.visibleWhen || f.visibleWhen(this.values())),
  );
  readonly errors = computed(() => {
    const v = this.values();
    const errs: Record<string, string | null> = {};
    for (const f of this.visibleFields()) {
      const val = v[f.key];
      if (f.required && (val === '' || val === undefined || val === null)) errs[f.key] = this.i18n.t('common.required');
      else if (f.validate && val !== '') errs[f.key] = f.validate(val, v);
    }
    return errs;
  });

  constructor() {
    afterNextRender(() => {
      const target =
        (this.el.nativeElement.querySelector('[data-autofocus]') as HTMLElement | null) ??
        (this.el.nativeElement.querySelector(
          'input:not([type=checkbox]):not([type=radio]), textarea, select, button[type=submit]',
        ) as HTMLElement | null);
      target?.focus();
      if (target instanceof HTMLInputElement) target.select();
    });
  }

  id(f: FieldSpec) {
    return `fd-${f.key}`;
  }

  options(f: FieldSpec): FieldOption[] {
    return f.optionsWhen?.(this.values()) ?? f.options ?? [];
  }

  set(key: string, value: FieldValue) {
    this.values.update((v) => {
      const next = { ...v, [key]: value };
      // Campos derivados: se recalculan en orden, así uno puede depender de otro ya recalculado.
      for (const f of this.data.fields) {
        if (f.key !== key && f.autoValue?.deps.includes(key)) next[f.key] = f.autoValue.compute(next);
      }
      // Si cambia un valor del que dependen las opciones de otro select, se corrige su selección.
      for (const f of this.data.fields) {
        if (f.type !== 'select' || !f.optionsWhen || f.key === key) continue;
        const opts = f.optionsWhen(next);
        if (!opts.some((o) => o.value === next[f.key])) next[f.key] = opts[0]?.value ?? '';
      }
      return next;
    });
  }

  async browse(f: FieldSpec) {
    const dir = await this.bridge.app('pickDirectory', f.label);
    if (dir) this.set(f.key, dir);
  }

  async submit() {
    this.touched.set(true);
    if (Object.values(this.errors()).some(Boolean)) return;
    const values = this.values();
    if (!this.data.run) {
      this.ref.close(values);
      return;
    }
    this.running.set(true);
    this.runError.set(null);
    try {
      if (this.data.beforeRun && !(await this.data.beforeRun(values))) return;
      await this.data.run(values);
      this.ref.close(values);
    } catch (e) {
      this.runError.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.running.set(false);
    }
  }
}

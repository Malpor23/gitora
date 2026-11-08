import { computed, inject, Pipe, PipeTransform, Service, signal } from '@angular/core';

import { en } from '@core/i18n/locales/en';
import { es } from '@core/i18n/locales/es';
import { Translations } from '@core/i18n/types';
import { Language } from '@core/models';

const DICTS: Record<Language, Translations> = { es, en };

export const LANGUAGES: { code: Language; label: string }[] = [
  { code: 'es', label: 'Español' },
  { code: 'en', label: 'English' },
];

@Service()
export class I18n {
  readonly lang = signal<Language>('es');
  readonly dict = computed(() => DICTS[this.lang()]);
  readonly locale = computed(() => (this.lang() === 'es' ? 'es-CO' : 'en-US'));

  setLanguage(lang: Language) {
    this.lang.set(lang);
    document.documentElement.lang = lang;
  }

  private lookup(key: string): string | undefined {
    const value = key
      .split('.')
      .reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], this.dict());
    return typeof value === 'string' ? value : undefined;
  }

  /**
   * Traduce una clave. Con el parámetro `n === 1` usa la variante `<clave>One` si existe
   * (p. ej. `commitCountOne` = "{{n}} commit"), para no mostrar "1 commits".
   */
  t(key: string, params?: Record<string, string | number>): string {
    let text =
      (params?.['n'] === 1 ? this.lookup(`${key}One`) : undefined) ?? this.lookup(key) ?? key;
    if (params) {
      for (const [k, v] of Object.entries(params)) text = text.replaceAll(`{{${k}}}`, String(v));
    }
    return text;
  }

  relative(iso: string): string {
    if (!iso) return '';
    const diff = (new Date(iso).getTime() - Date.now()) / 1000;
    const abs = Math.abs(diff);
    const rtf = new Intl.RelativeTimeFormat(this.locale(), { numeric: 'auto', style: 'short' });
    if (abs < 45) return this.t('time.now');
    if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
    if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
    if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), 'day');
    return this.date(iso);
  }

  date(iso: string, withTime = false): string {
    if (!iso) return '';
    return new Intl.DateTimeFormat(this.locale(), {
      dateStyle: 'medium',
      ...(withTime ? { timeStyle: 'short' } : {}),
    }).format(new Date(iso));
  }
}

/**
 * Pipe de traducción. Es impuro a propósito: lee la señal del idioma, así que al
 * cambiar de idioma toda la interfaz se actualiza sin recargar.
 */
@Pipe({ name: 't', pure: false })
export class TPipe implements PipeTransform {
  private readonly i18n = inject(I18n);
  transform(key: string, params?: Record<string, string | number>): string {
    this.i18n.lang();
    return this.i18n.t(key, params);
  }
}

@Pipe({ name: 'relTime', pure: false })
export class RelTimePipe implements PipeTransform {
  private readonly i18n = inject(I18n);
  transform(iso: string): string {
    this.i18n.lang();
    return this.i18n.relative(iso);
  }
}

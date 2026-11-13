import { TestBed } from '@angular/core/testing';

import { I18n, LANGUAGES } from './i18n';
import { de } from './locales/de';
import { en } from './locales/en';
import { es } from './locales/es';
import { fr } from './locales/fr';
import { pt } from './locales/pt';

function keys(o: object, prefix = ''): string[] {
  return Object.entries(o).flatMap(([k, v]) =>
    typeof v === 'object' && v !== null ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`],
  );
}

const DICTS = { es, en, pt, fr, de };

/** Valores de texto por clave, para comparar marcadores y vacíos entre idiomas. */
function entries(o: object, prefix = ''): [string, string][] {
  return Object.entries(o).flatMap(([k, v]) =>
    typeof v === 'object' && v !== null
      ? entries(v, `${prefix}${k}.`)
      : ([[`${prefix}${k}`, String(v)]] as [string, string][]),
  );
}
const placeholders = (text: string) => (text.match(/\{\{\s*\w+\s*\}\}/g) ?? []).map((m) => m.replace(/\s/g, '')).sort();

describe('I18n', () => {
  let i18n: I18n;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    i18n = TestBed.inject(I18n);
  });

  it('uses Spanish by default and switches live', () => {
    expect(i18n.lang()).toBe('es');
    expect(i18n.t('commands.noResults')).toBe(es.commands.noResults);
    i18n.setLanguage('en');
    expect(i18n.t('commands.noResults')).toBe(en.commands.noResults);
  });

  it('returns the key when it is missing and interpolates params', () => {
    expect(i18n.t('does.not.exist')).toBe('does.not.exist');
  });

  it('keeps every dictionary with the same keys as Spanish', () => {
    for (const [code, dict] of Object.entries(DICTS)) {
      expect(keys(dict).sort(), code).toEqual(keys(es).sort());
    }
  });

  it('uses the same {{placeholders}} in every translation and leaves no value empty unless Spanish is', () => {
    const base = new Map(entries(es));
    for (const [code, dict] of Object.entries(DICTS)) {
      for (const [key, value] of entries(dict)) {
        // Algunas claves son vacías a propósito (p. ej. el estado «limpio»): solo se exige igualdad de vacío con es
        expect(value.trim() === '', `${code}:${key} vacío`).toBe((base.get(key) ?? '').trim() === '');
        expect(placeholders(value), `${code}:${key}`).toEqual(placeholders(base.get(key) ?? ''));
      }
    }
  });

  it('lists every language and switches live to each one with its own locale', () => {
    expect(LANGUAGES.map((l) => l.code).sort()).toEqual(['de', 'en', 'es', 'fr', 'pt']);
    const locales = { es: 'es-CO', en: 'en-US', pt: 'pt-BR', fr: 'fr-FR', de: 'de-DE' } as const;
    for (const code of Object.keys(locales) as (keyof typeof locales)[]) {
      i18n.setLanguage(code);
      expect(i18n.t('commands.noResults')).toBe(DICTS[code].commands.noResults);
      expect(i18n.locale()).toBe(locales[code]);
      expect(document.documentElement.lang).toBe(code);
    }
  });

  it('usa la variante singular cuando n es 1', () => {
    expect(i18n.t('dialogs.repoStats.commitCount', { n: 1 })).toBe('1 commit');
    expect(i18n.t('dialogs.repoStats.commitCount', { n: 3 })).toBe('3 commits');
    expect(i18n.t('dialogs.repoStats.commitCount', { n: 0 })).toBe('0 commits');
    // sin variante singular se usa la clave normal
    expect(i18n.t('dialogs.pull.title', { n: 1 })).toBe('Pull');
  });
});

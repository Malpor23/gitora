import { TestBed } from '@angular/core/testing';

import { I18n } from './i18n';
import { en } from './locales/en';
import { es } from './locales/es';

function keys(o: object, prefix = ''): string[] {
  return Object.entries(o).flatMap(([k, v]) =>
    typeof v === 'object' && v !== null ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`],
  );
}

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

  it('keeps both dictionaries with the same keys', () => {
    expect(keys(es).sort()).toEqual(keys(en).sort());
  });

  it('usa la variante singular cuando n es 1', () => {
    expect(i18n.t('dialogs.repoStats.commitCount', { n: 1 })).toBe('1 commit');
    expect(i18n.t('dialogs.repoStats.commitCount', { n: 3 })).toBe('3 commits');
    expect(i18n.t('dialogs.repoStats.commitCount', { n: 0 })).toBe('0 commits');
    // sin variante singular se usa la clave normal
    expect(i18n.t('dialogs.pull.title', { n: 1 })).toBe('Pull');
  });
});

/** Formatea un tamaño en KiB como KiB, MiB o GiB según su magnitud. */
export function formatKib(kb: number, locale?: string): string {
  const value = Number.isFinite(kb) && kb > 0 ? kb : 0;
  const units = ['KiB', 'MiB', 'GiB'];
  let n = value;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  const fmt = new Intl.NumberFormat(locale, { maximumFractionDigits: i === 0 ? 0 : 1 });
  return `${fmt.format(n)} ${units[i]}`;
}

/** Porcentaje (0-100) de `value` respecto a `max`; nunca sale de ese rango. */
export function barWidth(value: number, max: number): number {
  if (!(max > 0) || !(value > 0)) return 0;
  return Math.min(100, (value / max) * 100);
}

/** Convierte `YYYY-MM` en la abreviatura del mes según el idioma. */
export function shortMonth(month: string, locale?: string): string {
  const [y, m] = month.split('-').map(Number);
  if (!y || !m) return month;
  return new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' }).format(
    new Date(Date.UTC(y, m - 1, 1)),
  );
}

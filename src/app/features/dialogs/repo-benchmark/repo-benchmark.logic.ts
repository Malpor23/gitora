import { BenchmarkResult } from '@core/models';

export type SpeedLevel = 'fast' | 'ok' | 'slow';

/** Suma de los tiempos de las pruebas que terminaron bien. */
export function totalMs(results: readonly BenchmarkResult[]): number {
  return results.reduce((sum, r) => sum + (r.ms ?? 0), 0);
}

/** Porcentaje de la barra: 100 para la más lenta, 0 si falló, mínimo 2% si es muy pequeña. */
export function barPercent(ms: number | null, results: readonly BenchmarkResult[]): number {
  if (ms === null) return 0;
  const max = results.reduce((m, r) => (r.ms !== null && r.ms > m ? r.ms : m), 0);
  if (max <= 0 || ms <= 0) return 0;
  return Math.min(100, Math.max(2, (ms / max) * 100));
}

/** Clasifica la velocidad: < 100 ms rápida, < 1000 ms aceptable, el resto lenta. */
export function speedLevel(ms: number): SpeedLevel {
  if (ms < 100) return 'fast';
  if (ms < 1000) return 'ok';
  return 'slow';
}

/** Clase de color (token del tema) para la barra de una prueba. */
export function barClass(ms: number | null): string {
  if (ms === null) return 'bg-danger';
  const level = speedLevel(ms);
  return level === 'fast' ? 'bg-success' : level === 'ok' ? 'bg-warning' : 'bg-danger';
}

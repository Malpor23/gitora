import { BenchmarkResult } from '@core/models';

import { barClass, barPercent, speedLevel, totalMs } from './repo-benchmark.logic';

const r = (ms: number | null): BenchmarkResult => ({ name: 'n', command: 'git x', ms });

describe('repo-benchmark logic', () => {
  it('totalMs suma solo las pruebas exitosas', () => {
    expect(totalMs([r(10), r(null), r(5.5)])).toBe(15.5);
    expect(totalMs([])).toBe(0);
  });

  it('barPercent: 0 para null, 100 para la más lenta, proporcional al resto', () => {
    const list = [r(200), r(50), r(null)];
    expect(barPercent(null, list)).toBe(0);
    expect(barPercent(200, list)).toBe(100);
    expect(barPercent(50, list)).toBe(25);
  });

  it('barPercent: mínimo 2% para valores pequeños distintos de cero', () => {
    expect(barPercent(1, [r(1000), r(1)])).toBe(2);
  });

  it('barPercent: 0 cuando todo vale cero', () => {
    expect(barPercent(0, [r(0)])).toBe(0);
  });

  it('speedLevel clasifica por umbrales', () => {
    expect(speedLevel(0)).toBe('fast');
    expect(speedLevel(99)).toBe('fast');
    expect(speedLevel(100)).toBe('ok');
    expect(speedLevel(999)).toBe('ok');
    expect(speedLevel(1000)).toBe('slow');
  });

  it('barClass usa tokens del tema', () => {
    expect(barClass(10)).toBe('bg-success');
    expect(barClass(500)).toBe('bg-warning');
    expect(barClass(5000)).toBe('bg-danger');
    expect(barClass(null)).toBe('bg-danger');
  });
});

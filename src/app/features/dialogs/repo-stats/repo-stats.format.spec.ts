import { barWidth, formatKib, shortMonth } from './repo-stats.format';

describe('repo-stats.format', () => {
  it('formats KiB, MiB and GiB', () => {
    expect(formatKib(512, 'en-US')).toBe('512 KiB');
    expect(formatKib(2048, 'en-US')).toBe('2 MiB');
    expect(formatKib(1536 * 1024, 'en-US')).toBe('1.5 GiB');
  });

  it('treats invalid sizes as zero', () => {
    expect(formatKib(-5, 'en-US')).toBe('0 KiB');
    expect(formatKib(NaN, 'en-US')).toBe('0 KiB');
  });

  it('computes a proportional bar width', () => {
    expect(barWidth(5, 10)).toBe(50);
    expect(barWidth(10, 10)).toBe(100);
    expect(barWidth(0, 10)).toBe(0);
    expect(barWidth(5, 0)).toBe(0);
    expect(barWidth(20, 10)).toBe(100);
  });

  it('abbreviates the month', () => {
    expect(shortMonth('2026-03', 'en-US')).toBe('Mar');
    expect(shortMonth('bad', 'en-US')).toBe('bad');
  });
});

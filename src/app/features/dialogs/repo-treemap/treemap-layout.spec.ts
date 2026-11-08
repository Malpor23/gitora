import { layoutTreemap } from './treemap-layout';

const EPS = 1e-6;

describe('layoutTreemap', () => {
  const items = [
    { id: 'a', value: 6 },
    { id: 'b', value: 6 },
    { id: 'c', value: 4 },
    { id: 'd', value: 3 },
    { id: 'e', value: 2 },
    { id: 'f', value: 2 },
    { id: 'g', value: 1 },
  ];

  it('suma de areas igual al area total', () => {
    const r = layoutTreemap(items, 760, 420);
    const sum = r.reduce((s, x) => s + x.w * x.h, 0);
    expect(r.length).toBe(items.length);
    expect(Math.abs(sum - 760 * 420)).toBeLessThan(1e-4);
  });

  it('cada area es proporcional al valor', () => {
    const total = items.reduce((s, i) => s + i.value, 0);
    for (const rect of layoutTreemap(items, 100, 50)) {
      const v = items.find((i) => i.id === rect.id)!.value;
      expect(Math.abs(rect.w * rect.h - (v / total) * 5000)).toBeLessThan(1e-6);
    }
  });

  it('queda dentro de los limites y sin solapes', () => {
    const r = layoutTreemap(items, 300, 200);
    for (const a of r) {
      expect(a.x).toBeGreaterThanOrEqual(-EPS);
      expect(a.y).toBeGreaterThanOrEqual(-EPS);
      expect(a.x + a.w).toBeLessThanOrEqual(300 + EPS);
      expect(a.y + a.h).toBeLessThanOrEqual(200 + EPS);
    }
    for (let i = 0; i < r.length; i++) {
      for (let j = i + 1; j < r.length; j++) {
        const ox = Math.min(r[i].x + r[i].w, r[j].x + r[j].w) - Math.max(r[i].x, r[j].x);
        const oy = Math.min(r[i].y + r[i].h, r[j].y + r[j].h) - Math.max(r[i].y, r[j].y);
        expect(ox > EPS && oy > EPS).toBe(false);
      }
    }
  });

  it('un solo elemento llena la caja', () => {
    expect(layoutTreemap([{ id: 'x', value: 5 }], 120, 80)).toEqual([
      { id: 'x', x: 0, y: 0, w: 120, h: 80 },
    ]);
  });

  it('descarta valores cero, negativos y no finitos', () => {
    const r = layoutTreemap(
      [
        { id: 'a', value: 1 },
        { id: 'z', value: 0 },
        { id: 'n', value: -3 },
        { id: 'i', value: NaN },
      ],
      10,
      10,
    );
    expect(r.map((x) => x.id)).toEqual(['a']);
  });

  it('ordena por valor descendente y es determinista', () => {
    const r = layoutTreemap(items, 300, 200);
    expect(r.map((x) => x.id).slice(0, 2)).toEqual(['a', 'b']);
    expect(layoutTreemap(items, 300, 200)).toEqual(r);
  });

  it('vacio o caja degenerada devuelve lista vacia', () => {
    expect(layoutTreemap([], 10, 10)).toEqual([]);
    expect(layoutTreemap(items, 0, 10)).toEqual([]);
  });
});

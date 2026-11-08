export interface TreemapItem {
  id: string;
  value: number;
}

export interface TreemapRect {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Peor relación de aspecto de una fila de áreas colocada sobre un lado de longitud `side`. */
function worst(areas: number[], side: number): number {
  const sum = areas.reduce((a, b) => a + b, 0);
  const max = Math.max(...areas);
  const min = Math.min(...areas);
  const s2 = side * side;
  return Math.max((s2 * max) / (sum * sum), (sum * sum) / (s2 * min));
}

/**
 * Treemap "squarified" (Bruls, Huizing, van Wijk). Ignora valores no positivos,
 * ordena por valor descendente y reparte el área width*height sin solapes.
 */
export function layoutTreemap(items: TreemapItem[], width: number, height: number): TreemapRect[] {
  const valid = items
    .filter((i) => Number.isFinite(i.value) && i.value > 0)
    .sort((a, b) => b.value - a.value);
  if (valid.length === 0 || width <= 0 || height <= 0) return [];

  const total = valid.reduce((s, i) => s + i.value, 0);
  const scale = (width * height) / total;
  const areas = valid.map((i) => i.value * scale);
  const out: TreemapRect[] = [];

  let x = 0;
  let y = 0;
  let w = width;
  let h = height;
  let start = 0;

  while (start < valid.length) {
    const side = Math.min(w, h);
    let end = start + 1;
    let row = [areas[start]];
    while (end < valid.length && worst([...row, areas[end]], side) <= worst(row, side)) {
      row.push(areas[end]);
      end++;
    }
    const rowSum = row.reduce((a, b) => a + b, 0);
    const last = end >= valid.length;
    if (w >= h) {
      // La fila forma una columna a la izquierda
      const colW = last ? w : rowSum / h;
      let cy = y;
      row.forEach((a, k) => {
        const rh = k === row.length - 1 && last ? y + h - cy : a / colW;
        out.push({ id: valid[start + k].id, x, y: cy, w: colW, h: rh });
        cy += rh;
      });
      x += colW;
      w -= colW;
    } else {
      // La fila forma una banda en la parte superior
      const rowH = last ? h : rowSum / w;
      let cx = x;
      row.forEach((a, k) => {
        const rw = k === row.length - 1 && last ? x + w - cx : a / rowH;
        out.push({ id: valid[start + k].id, x: cx, y, w: rw, h: rowH });
        cx += rw;
      });
      y += rowH;
      h -= rowH;
    }
    row = [];
    start = end;
  }
  return out;
}

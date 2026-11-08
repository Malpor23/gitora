import { Commit } from '@core/models';

export interface GraphEdge {
  from: number;
  to: number;
  color: number;
  half: 'top' | 'bottom';
}

export interface GraphRow {
  lane: number;
  color: number;
  edges: GraphEdge[];
  width: number;        // carriles ocupados en esta fila
  isMerge: boolean;
}

export const LANE_COLORS = 8;

/**
 * Asigna carriles a commits en orden topológico (el que entrega `git log --topo-order`).
 *
 * Mantiene la lista de carriles "abiertos": cada uno espera ver un hash concreto más
 * abajo. Cuando llega ese commit se dibuja en su carril; los demás carriles que también
 * lo esperaban confluyen en él (ramas que se unieron). El primer padre continúa en el
 * mismo carril y cada padre extra abre (o reutiliza) otro: así una rama conserva su color.
 */
export function computeGraph(commits: Commit[]): GraphRow[] {
  const lanes: (string | null)[] = [];
  const laneColor: number[] = [];
  let nextColor = 0;
  const rows: GraphRow[] = [];

  const allocate = (exclude: number): number => {
    let idx = lanes.findIndex((l, i) => l === null && i !== exclude);
    if (idx === -1) idx = lanes.length;
    laneColor[idx] = nextColor++ % LANE_COLORS;
    return idx;
  };

  for (const commit of commits) {
    const top = [...lanes];
    const matches: number[] = [];
    top.forEach((h, i) => {
      if (h === commit.hash) matches.push(i);
    });

    let lane: number;
    if (matches.length) {
      lane = matches[0];
    } else {
      lane = allocate(-1);
      lanes[lane] = commit.hash;
    }
    const color = laneColor[lane];
    const edges: GraphEdge[] = [];

    // Mitad superior: carriles que vienen de arriba
    top.forEach((h, i) => {
      if (h === null) return;
      if (matches.includes(i)) edges.push({ from: i, to: lane, color: laneColor[i], half: 'top' });
      else edges.push({ from: i, to: i, color: laneColor[i], half: 'top' });
    });

    // Actualizar carriles con los padres
    for (const m of matches) if (m !== lane) lanes[m] = null;
    const [first, ...others] = commit.parents;
    lanes[lane] = first ?? null;

    const parentLanes: number[] = [];
    for (const p of others) {
      let idx = lanes.findIndex((h) => h === p);
      if (idx === -1) {
        idx = allocate(lane);
        lanes[idx] = p;
      }
      parentLanes.push(idx);
    }

    // Mitad inferior: continuaciones
    lanes.forEach((h, i) => {
      if (h === null) return;
      if (i === lane) {
        edges.push({ from: lane, to: lane, color, half: 'bottom' });
      } else if (parentLanes.includes(i) && top[i] !== h) {
        // carril recién abierto (o reutilizado) para un padre de merge
        edges.push({ from: lane, to: i, color: laneColor[i], half: 'bottom' });
      } else if (parentLanes.includes(i)) {
        edges.push({ from: lane, to: i, color: laneColor[i], half: 'bottom' });
        edges.push({ from: i, to: i, color: laneColor[i], half: 'bottom' });
      } else {
        edges.push({ from: i, to: i, color: laneColor[i], half: 'bottom' });
      }
    });

    // Recortar carriles vacíos del final
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();

    const width = Math.max(top.length, lanes.length, lane + 1);
    rows.push({ lane, color, edges, width, isMerge: commit.parents.length > 1 });
  }
  return rows;
}

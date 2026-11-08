import { Component, computed, input } from '@angular/core';

import { GraphRow } from '@core/graph';

export const LANE_W = 14;
export const ROW_H = 28;

/**
 * Dibuja el tramo del grafo de una fila: líneas de carriles y el nodo del commit.
 * */
@Component({
  selector: 'gt-graph-cell',
  template: `
    <svg class="block overflow-visible" [attr.width]="width()" [attr.height]="h" [attr.viewBox]="'0 0 ' + width() + ' ' + h">
      @for (e of row().edges; track $index) {
        <path
          [attr.d]="path(e.from, e.to, e.half)"
          [attr.stroke]="'var(--lane-' + e.color + ')'"
          fill="none"
          stroke-width="2"
        />
      }
      @if (head()) {
        <circle
          [attr.cx]="x(row().lane)"
          [attr.cy]="h / 2"
          r="6.5"
          fill="none"
          [attr.stroke]="'var(--lane-' + row().color + ')'"
          stroke-width="2"
        />
      }
      <circle
        [attr.cx]="x(row().lane)"
        [attr.cy]="h / 2"
        [attr.r]="row().isMerge ? 3 : 4"
        [attr.fill]="row().isMerge ? 'var(--bg)' : 'var(--lane-' + row().color + ')'"
        [attr.stroke]="'var(--lane-' + row().color + ')'"
        stroke-width="2"
      />
    </svg>
  `,
  host: { class: 'block leading-none' },
})
export class GraphCell {
  readonly row = input.required<GraphRow>();
  readonly maxLanes = input(1);
  readonly head = input(false);
  readonly h = ROW_H;
  readonly width = computed(() => Math.max(this.maxLanes(), 1) * LANE_W + 6);

  x(lane: number) {
    return lane * LANE_W + LANE_W / 2 + 2;
  }

  path(from: number, to: number, half: 'top' | 'bottom'): string {
    const h = this.h;
    const mid = h / 2;
    const x1 = this.x(from);
    const x2 = this.x(to);
    if (half === 'top') {
      if (from === to) return `M${x1},0 L${x1},${mid}`;
      return `M${x1},0 C${x1},${mid * 0.9} ${x2},${mid * 0.4} ${x2},${mid}`;
    }
    if (from === to) return `M${x1},${mid} L${x1},${h}`;
    return `M${x1},${mid} C${x1},${mid + mid * 0.6} ${x2},${mid + mid * 0.1} ${x2},${h}`;
  }
}

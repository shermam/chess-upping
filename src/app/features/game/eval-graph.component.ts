import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { Judgement, JUDGEMENT_SYMBOL } from '../../models/analysis';
import { PositionEval, formatEval, whiteWinChance } from '../../models/position-eval';

export interface EvalPoint {
  ply: number;
  san: string | null;
  eval: PositionEval | null;
  judgement: Judgement | null;
}

const W = 600;
const H = 120;
const PAD = 4;

/**
 * The classic evaluation graph: White's winning chances over the game, with
 * the area above the midline light and below it dark. One series, so no
 * legend; a hover tooltip names the move and the score, and clicking jumps
 * to that ply. Mistakes are marked with a labelled dot.
 */
@Component({
  selector: 'app-eval-graph',
  template: `
    <svg
      class="graph"
      [attr.viewBox]="'0 0 ' + width + ' ' + height"
      preserveAspectRatio="none"
      role="img"
      aria-label="Evaluation over the game"
      (mousemove)="onMove($event)"
      (mouseleave)="hover.set(null)"
      (click)="onClick($event)"
    >
      <defs>
        <clipPath id="above">
          <rect x="0" y="0" [attr.width]="width" [attr.height]="height / 2" />
        </clipPath>
        <clipPath id="below">
          <rect x="0" [attr.y]="height / 2" [attr.width]="width" [attr.height]="height / 2" />
        </clipPath>
      </defs>
      <rect class="bg" x="0" y="0" [attr.width]="width" [attr.height]="height" />
      <path class="area-white" [attr.d]="areaPath()" clip-path="url(#above)" />
      <path class="area-black" [attr.d]="areaPath()" clip-path="url(#below)" />
      <line class="mid" x1="0" [attr.y1]="height / 2" [attr.x2]="width" [attr.y2]="height / 2" />
      <path class="line" [attr.d]="linePath()" />
      @for (m of marks(); track m.ply) {
        <circle [attr.cx]="m.x" [attr.cy]="m.y" r="4" [class]="'mark ' + m.judgement" />
      }
      <line class="cursor" [attr.x1]="cursorX()" y1="0" [attr.x2]="cursorX()" [attr.y2]="height" />
      @if (hover(); as h) {
        <line class="hover" [attr.x1]="h.x" y1="0" [attr.x2]="h.x" [attr.y2]="height" />
      }
    </svg>
    @if (hover(); as h) {
      <div class="tooltip" [style.left.%]="(h.x / width) * 100">{{ h.label }}</div>
    }
  `,
  styles: `
    :host {
      display: block;
      position: relative;
    }
    .graph {
      display: block;
      width: 100%;
      height: 96px;
      cursor: pointer;
      border-radius: 6px;
      overflow: hidden;
    }
    .bg {
      fill: #8d8782;
    }
    .area-white {
      fill: #f4f1ea;
    }
    .area-black {
      fill: #403d39;
    }
    .mid {
      stroke: #c8c8c8;
      stroke-width: 1;
      vector-effect: non-scaling-stroke;
    }
    .line {
      fill: none;
      stroke: #1f1d1b;
      stroke-width: 2;
      vector-effect: non-scaling-stroke;
    }
    .cursor {
      stroke: var(--mat-sys-primary);
      stroke-width: 2;
      vector-effect: non-scaling-stroke;
    }
    .hover {
      stroke: #000;
      stroke-opacity: 0.4;
      stroke-width: 1;
      vector-effect: non-scaling-stroke;
    }
    .mark {
      stroke: #fff;
      stroke-width: 1.5;
      vector-effect: non-scaling-stroke;
      &.inaccuracy {
        fill: #56b4e9;
      }
      &.mistake {
        fill: #e69f00;
      }
      &.blunder {
        fill: #d55e00;
      }
    }
    .tooltip {
      position: absolute;
      top: 4px;
      transform: translateX(-50%);
      padding: 2px 6px;
      border-radius: 4px;
      background: var(--mat-sys-inverse-surface);
      color: var(--mat-sys-inverse-on-surface);
      font: var(--mat-sys-label-small);
      white-space: nowrap;
      pointer-events: none;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EvalGraphComponent {
  readonly points = input.required<readonly EvalPoint[]>();
  readonly current = input(0);
  readonly plySelect = output<number>();

  protected readonly width = W;
  protected readonly height = H;
  protected readonly hover = signal<{ x: number; label: string } | null>(null);

  private readonly step = computed(() => W / Math.max(1, this.points().length - 1));

  private x(ply: number): number {
    return ply * this.step();
  }

  private y(e: PositionEval): number {
    return PAD + (1 - whiteWinChance(e)) * (H - 2 * PAD);
  }

  protected readonly linePath = computed(() => {
    let d = '';
    let pen = false;
    for (const p of this.points()) {
      if (!p.eval) {
        pen = false;
        continue;
      }
      d += `${pen ? 'L' : 'M'}${this.x(p.ply).toFixed(1)},${this.y(p.eval).toFixed(1)} `;
      pen = true;
    }
    return d;
  });

  protected readonly areaPath = computed(() => {
    const pts = this.points().filter((p) => p.eval);
    if (pts.length === 0) return '';
    const first = pts[0];
    const last = pts[pts.length - 1];
    let d = `M${this.x(first.ply).toFixed(1)},${H / 2} `;
    for (const p of pts) d += `L${this.x(p.ply).toFixed(1)},${this.y(p.eval!).toFixed(1)} `;
    d += `L${this.x(last.ply).toFixed(1)},${H / 2} Z`;
    return d;
  });

  protected readonly marks = computed(() =>
    this.points()
      .filter((p) => p.judgement && p.eval)
      .map((p) => ({ ply: p.ply, x: this.x(p.ply), y: this.y(p.eval!), judgement: p.judgement! })),
  );

  protected readonly cursorX = computed(() => this.x(this.current()));

  private plyAt(event: MouseEvent): number {
    const rect = (event.currentTarget as SVGElement).getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    return Math.round(frac * (this.points().length - 1));
  }

  protected onMove(event: MouseEvent): void {
    const ply = this.plyAt(event);
    const p = this.points()[ply];
    if (!p) return;
    const move = p.san ? `${Math.ceil(ply / 2)}${ply % 2 ? '.' : '…'} ${p.san}` : 'Start';
    const score = p.eval ? formatEval(p.eval) : '…';
    const tag = p.judgement ? ` ${JUDGEMENT_SYMBOL[p.judgement]}` : '';
    this.hover.set({ x: this.x(ply), label: `${move}${tag} ${score}` });
  }

  protected onClick(event: MouseEvent): void {
    this.plySelect.emit(this.plyAt(event));
  }
}

import { useState } from 'react';

export interface Bar {
  key: string;
  label: string;
  value: number;
  detail?: string;
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * exp >= v) return m * exp;
  return 10 * exp;
}

export function BarChart({
  bars,
  format,
  height = 220,
  testId,
  title,
}: {
  bars: Bar[];
  format: (v: number) => string;
  height?: number;
  testId?: string;
  title: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const width = 760;
  const pad = { top: 12, right: 12, bottom: 28, left: 56 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const max = niceMax(Math.max(0, ...bars.map((b) => b.value)));
  const slot = bars.length > 0 ? innerW / bars.length : innerW;
  const barW = Math.max(2, Math.min(28, slot - 2));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * max);
  const labelEvery = Math.max(1, Math.ceil(bars.length / 10));
  const active = hover !== null ? bars[hover] : undefined;
  return (
    <figure className="chart" data-testid={testId}>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title} preserveAspectRatio="none">
        {ticks.map((t) => {
          const y = pad.top + innerH - (t / max) * innerH;
          return (
            <g key={t}>
              <line x1={pad.left} x2={width - pad.right} y1={y} y2={y} className="chart-grid" />
              <text x={pad.left - 8} y={y + 4} textAnchor="end" className="chart-axis">
                {format(t)}
              </text>
            </g>
          );
        })}
        {bars.map((b, i) => {
          const h = (b.value / max) * innerH;
          const x = pad.left + i * slot + (slot - barW) / 2;
          const y = pad.top + innerH - h;
          const r = Math.min(4, barW / 2, h);
          const path =
            h <= 0
              ? ''
              : `M${x},${pad.top + innerH} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + barW - r},${y} Q${x + barW},${y} ${x + barW},${y + r} L${x + barW},${pad.top + innerH} Z`;
          return (
            <g key={b.key} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={pad.left + i * slot} y={pad.top} width={slot} height={innerH} fill="transparent" />
              {path !== '' ? (
                <path d={path} className={hover === i ? 'chart-bar chart-bar-hover' : 'chart-bar'} />
              ) : null}
              <title>{`${b.label}: ${format(b.value)}${b.detail ? ` · ${b.detail}` : ''}`}</title>
              {i % labelEvery === 0 ? (
                <text x={pad.left + i * slot + slot / 2} y={height - 8} textAnchor="middle" className="chart-axis">
                  {b.label}
                </text>
              ) : null}
            </g>
          );
        })}
        <line
          x1={pad.left}
          x2={width - pad.right}
          y1={pad.top + innerH}
          y2={pad.top + innerH}
          className="chart-baseline"
        />
      </svg>
      <figcaption className="chart-caption">
        {active !== undefined ? (
          <>
            <strong>{active.label}</strong> · {format(active.value)}
            {active.detail ? ` · ${active.detail}` : ''}
          </>
        ) : (
          <span className="muted">Hover a bar for details</span>
        )}
      </figcaption>
    </figure>
  );
}

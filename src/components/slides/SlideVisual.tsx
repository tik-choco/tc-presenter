// Renders a Slide's `visual` field: the pill-node/pictogram mindmap-style
// diagrams (icon_diagram/network_graph/flowchart), a data table, or a small
// inline SVG chart (line/bar) — no charting library dependency, see
// PLAN.md/notes-slide-quality.md §5 (`SlideVisual`, `DataTable`, `SlideChart`
// shapes) and §2 "角丸ピル型ボックス+接続線によるマインドマップ...が頻出".
//
// VisualElement only carries a label/color/relative-position for itself (no
// from/to node references), so 'arrow'/'edge' elements are rendered as a
// line spanning their own (x,y)->(x+w,y+h) bounding box rather than a
// connector between two other elements' ids.
import { t } from '../../i18n'
import type { DataTable, SlideChart, SlideVisual as SlideVisualData, VisualElement } from '../../types'
import { getIconForLabel } from './icons'

function isEdgeLike(type: VisualElement['type']): boolean {
  return type === 'arrow' || type === 'edge'
}

function DiagramView({ kind, elements }: { kind: string; elements: VisualElement[] }) {
  const edges = elements.filter((e) => isEdgeLike(e.type))
  const nodes = elements.filter((e) => !isEdgeLike(e.type))

  return (
    <div class="slide-diagram" data-kind={kind}>
      <svg class="slide-diagram__edges" viewBox="0 0 100 100" preserveAspectRatio="none">
        <defs>
          <marker id="slide-arrowhead" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
            <path d="M0,0 L6,3 L0,6 Z" class="slide-diagram__arrowhead" />
          </marker>
        </defs>
        {edges.map((e, i) => (
          <line
            key={i}
            x1={e.position.x * 100}
            y1={e.position.y * 100}
            x2={(e.position.x + e.position.w) * 100}
            y2={(e.position.y + e.position.h) * 100}
            stroke={e.color || undefined}
            class="slide-diagram__edge"
            stroke-width={e.type === 'arrow' ? 1.4 : 1}
            stroke-dasharray={e.type === 'edge' ? '3 2' : undefined}
            marker-end={e.type === 'arrow' ? 'url(#slide-arrowhead)' : undefined}
          />
        ))}
      </svg>
      {nodes.map((n, i) => {
        const Icon = getIconForLabel(n.label)
        const w = Math.max(n.position.w, 0.1) * 100
        const h = Math.max(n.position.h, 0.12) * 100
        return (
          <div
            key={i}
            class={`slide-diagram__node slide-diagram__node--${n.type}`}
            style={{
              left: `${n.position.x * 100}%`,
              top: `${n.position.y * 100}%`,
              width: `${w}%`,
              height: `${h}%`,
              borderColor: n.color || undefined,
              color: n.color || undefined,
            }}
          >
            {n.type !== 'box' && <Icon class="slide-diagram__icon" size={18} strokeWidth={2} />}
            <span class="slide-diagram__label">{n.label}</span>
          </div>
        )
      })}
    </div>
  )
}

function DataTableView({ table }: { table: DataTable }) {
  return (
    <div class="slide-table-wrap">
      <table class="slide-table">
        <thead>
          <tr>
            {table.headers.map((h, i) => (
              <th key={i}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, ri) => (
            <tr key={ri}>
              {row.map((cell, ci) => (
                <td key={ci}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {(table.unit || table.significantDigits > 0) && (
        <p class="slide-table__meta">
          {table.unit && <span>{table.unit}</span>}
          {table.significantDigits > 0 && <span>{t('slide.significantDigits', { n: table.significantDigits })}</span>}
        </p>
      )}
    </div>
  )
}

const CHART_PALETTE = ['var(--slide-primary)', 'var(--slide-secondary)', 'var(--slide-warning)', 'var(--slide-gray)']

function ChartView({ chart }: { chart: SlideChart }) {
  const allPoints = chart.series.flatMap((s) => s.points)
  if (allPoints.length === 0) return null

  const xs = allPoints.map((p) => p.x)
  const ys = allPoints.map((p) => p.y)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(0, ...ys)
  const maxY = Math.max(...ys)
  const spanX = maxX - minX || 1
  const spanY = maxY - minY || 1
  const toX = (x: number) => ((x - minX) / spanX) * 100
  const toY = (y: number) => 100 - ((y - minY) / spanY) * 100
  const uniqueXCount = new Set(xs).size || 1

  return (
    <div class="slide-chart">
      <svg class="slide-chart__plot" viewBox="0 0 100 100" preserveAspectRatio="none">
        <line x1="0" y1="100" x2="100" y2="100" class="slide-chart__axis" />
        <line x1="0" y1="0" x2="0" y2="100" class="slide-chart__axis" />
        {chart.type === 'line'
          ? chart.series.map((s, i) => (
              <polyline
                key={s.name}
                points={s.points.map((p) => `${toX(p.x)},${toY(p.y)}`).join(' ')}
                fill="none"
                stroke={CHART_PALETTE[i % CHART_PALETTE.length]}
                stroke-width="1.6"
              />
            ))
          : chart.series.map((s, si) =>
              s.points.map((p, pi) => {
                const barWidth = 100 / uniqueXCount / (chart.series.length + 1)
                const x = toX(p.x) + si * barWidth
                const y = toY(p.y)
                return (
                  <rect
                    key={`${si}-${pi}`}
                    x={x}
                    y={y}
                    width={Math.max(barWidth, 1.5)}
                    height={Math.max(100 - y, 0)}
                    fill={CHART_PALETTE[si % CHART_PALETTE.length]}
                  />
                )
              }),
            )}
      </svg>
      <div class="slide-chart__legend">
        {chart.series.map((s, i) => (
          <span key={s.name} class="slide-chart__legend-item">
            <i style={{ background: CHART_PALETTE[i % CHART_PALETTE.length] }} />
            {s.name}
          </span>
        ))}
      </div>
      <div class="slide-chart__labels">
        <span>{chart.xLabel}</span>
        <span>{chart.yLabel}</span>
      </div>
      {chart.annotation && <p class="slide-chart__annotation">{chart.annotation}</p>}
    </div>
  )
}

export function SlideVisualBlock({ visual }: { visual: SlideVisualData }) {
  if (!visual || visual.kind === 'none') return null
  if (visual.dataTable) return <DataTableView table={visual.dataTable} />
  if (visual.chart) return <ChartView chart={visual.chart} />
  if (visual.elements && visual.elements.length > 0) return <DiagramView kind={visual.kind} elements={visual.elements} />
  return null
}

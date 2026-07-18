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

/** Computes an arrow's shaft-end point (pulled back from the true endpoint
 * by `size`) and its arrowhead triangle, all in the same 0-100 coordinate
 * space the <line> itself is drawn in. This replaces an SVG <marker>: a
 * marker auto-rotates its (isotropic) content to match the line's local
 * angle and only *then* gets carried through this SVG's viewBox transform —
 * which is non-uniform (`preserveAspectRatio="none"`, needed so edges track
 * node positions expressed as plain left/top percentages) whenever the
 * container isn't square. Rotate-then-nonuniform-scale shears an isotropic
 * shape into a lopsided parallelogram on any non-45°/90° edge. Computing the
 * triangle's vertices directly as real coordinates in this same space sidesteps
 * that: they go through the exact same (even non-uniform) transform as the
 * line's own endpoints, so the head stays a clean, correctly-attached
 * triangle regardless of the container's aspect ratio. */
function edgeArrowGeometry(x1: number, y1: number, x2: number, y2: number, size = 5) {
  const dx = x2 - x1
  const dy = y2 - y1
  const len = Math.hypot(dx, dy) || 1
  const ux = dx / len
  const uy = dy / len
  const px = -uy
  const py = ux
  const baseX = x2 - ux * size
  const baseY = y2 - uy * size
  const halfW = size * 0.6
  return {
    lineEnd: { x: baseX, y: baseY },
    points: `${x2},${y2} ${baseX + px * halfW},${baseY + py * halfW} ${baseX - px * halfW},${baseY - py * halfW}`,
  }
}

function DiagramView({ kind, elements }: { kind: string; elements: VisualElement[] }) {
  const edges = elements.filter((e) => isEdgeLike(e.type))
  const nodes = elements.filter((e) => !isEdgeLike(e.type))

  return (
    <div class="slide-diagram" data-kind={kind}>
      <svg class="slide-diagram__edges" viewBox="0 0 100 100" preserveAspectRatio="none">
        {edges.map((e, i) => {
          const x1 = e.position.x * 100
          const y1 = e.position.y * 100
          const x2 = (e.position.x + e.position.w) * 100
          const y2 = (e.position.y + e.position.h) * 100
          const isArrow = e.type === 'arrow'
          const arrow = isArrow ? edgeArrowGeometry(x1, y1, x2, y2) : null
          return (
            <g key={i}>
              <line
                x1={x1}
                y1={y1}
                x2={arrow ? arrow.lineEnd.x : x2}
                y2={arrow ? arrow.lineEnd.y : y2}
                stroke={e.color || undefined}
                class="slide-diagram__edge"
                stroke-width={isArrow ? 1.4 : 1}
                stroke-dasharray={e.type === 'edge' ? '3 2' : undefined}
              />
              {arrow && <polygon points={arrow.points} class="slide-diagram__arrowhead" />}
            </g>
          )
        })}
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

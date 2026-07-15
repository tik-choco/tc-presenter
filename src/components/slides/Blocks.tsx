// Renderers for the v2 block content model (Slide.blocks — see
// scratchpad/design-spec.md §2/§3). Each component below maps 1:1 to a
// ContentBlock['kind'] from src/types.ts and reproduces one of the reference
// deck's recurring visual patterns (pill rows, pictogram rows, box groups,
// mindmaps, flows, grid heatmaps, callouts, comparisons) rather than the
// generic node/edge DiagramView used by the legacy `visual` field.
//
// Colors are always resolved through the `--slide-*` custom properties that
// SlideView.tsx sets from DeckTheme.colorPalette — blocks never carry a
// literal hex (BlockColorRole is an indirection, see types.ts).
import { Check, X as XIcon } from 'lucide-preact'
import type { JSX } from 'preact'
import type {
  BlockColorRole,
  BoxGroupBlock,
  CalloutBoxBlock,
  ComparisonBlock,
  ContentBlock,
  FlowBlock,
  GridHeatmapBlock,
  IconRowBlock,
  ImageRefBlock,
  MindmapBlock,
  MindmapNode,
  PillRowBlock,
  PositionedBlock,
  QuoteBlock as QuoteBlockData,
} from '../../types'
import { getIconForLabel } from './icons'
import { SlideVisualBlock } from './SlideVisual'

function colorVar(role?: BlockColorRole): string {
  switch (role) {
    case 'secondary':
      return 'var(--slide-secondary)'
    case 'warning':
      return 'var(--slide-warning)'
    case 'neutral':
      return 'var(--slide-gray)'
    case 'primary':
    default:
      return 'var(--slide-primary)'
  }
}

function pillStyle(variant: 'filled' | 'outline' | undefined, role: BlockColorRole | undefined): JSX.CSSProperties {
  const c = colorVar(role)
  if (variant === 'outline') {
    return { color: c, borderColor: c, background: '#fff' }
  }
  return { background: c, borderColor: c, color: '#fff' }
}

// ---- A. pillRow ------------------------------------------------------------

function PillRowView({ block }: { block: PillRowBlock }) {
  return (
    <div class="block-pillrow" data-direction={block.direction ?? 'horizontal'}>
      {block.items.map((item, i) => (
        <div key={i} class="block-pillrow__item">
          <span class="block-pill" data-variant={item.variant ?? 'filled'} style={pillStyle(item.variant, item.color ?? 'primary')}>
            {item.text}
          </span>
          {item.description && <span class="block-pillrow__desc">{item.description}</span>}
        </div>
      ))}
    </div>
  )
}

// ---- B. iconRow -------------------------------------------------------------

function IconRowView({ block }: { block: IconRowBlock }) {
  return (
    <div class="block-iconrow">
      {block.items.map((item, i) => {
        const Icon = getIconForLabel(item.icon ?? item.label)
        return (
          <div key={i} class="block-iconrow__item" data-excluded={item.excluded ? 'true' : undefined}>
            <span class="block-iconrow__icon-wrap">
              <Icon class="block-iconrow__icon" size={40} strokeWidth={1.6} />
              {item.excluded && <XIcon class="block-iconrow__x" size={52} strokeWidth={3} aria-hidden="true" />}
            </span>
            <span class="block-iconrow__label">{item.label}</span>
          </div>
        )
      })}
    </div>
  )
}

// ---- C. boxGroup (single / grid / nested) ------------------------------------

function BoxGroupView({ block }: { block: BoxGroupBlock }) {
  if (block.layout === 'grid') {
    const rows = block.gridRows ?? 1
    const cols = block.gridCols ?? block.boxes.length
    const byCell = new Map<string, (typeof block.boxes)[number]>()
    for (const b of block.boxes) {
      if (b.row != null && b.col != null) byCell.set(`${b.row}:${b.col}`, b)
    }
    const cells: JSX.Element[] = []
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const b = byCell.get(`${r}:${c}`)
        cells.push(
          <div
            key={`${r}-${c}`}
            class="block-box block-box--grid-cell"
            data-variant={b?.variant ?? 'outline'}
            data-empty={b ? undefined : 'true'}
            style={b ? pillStyle(b.variant ?? 'outline', b.color ?? 'primary') : undefined}
          >
            {b && <span class="block-box__label">{b.label}</span>}
          </div>,
        )
      }
    }
    return (
      <div class="block-boxgroup block-boxgroup--grid-wrap">
        <div class="block-boxgroup__grid" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)`, gridTemplateRows: `repeat(${rows}, 1fr)` }}>
          {cells}
        </div>
        {block.legend && block.legend.length > 0 && (
          <ul class="block-legend">
            {block.legend.map((l, i) => (
              <li key={i} class="block-legend__item">
                <i style={{ background: colorVar(l.color) }} />
                <span>{l.label}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    )
  }

  if (block.layout === 'nested') {
    return (
      <div class="block-boxgroup block-boxgroup--nested">
        {block.boxes.map((b, i) => (
          <div
            key={i}
            class="block-box block-box--nested"
            data-variant={b.variant ?? 'outline'}
            style={{ ...pillStyle(b.variant ?? 'outline', b.color ?? 'primary'), '--nest-depth': i }}
          >
            <span class="block-box__label">{b.label}</span>
            {b.text && <span class="block-box__text">{b.text}</span>}
          </div>
        ))}
      </div>
    )
  }

  // single
  return (
    <div class="block-boxgroup block-boxgroup--single">
      {block.boxes.map((b, i) => (
        <div key={i} class="block-box block-box--tab" data-variant={b.variant ?? 'outline'} style={pillStyle(b.variant ?? 'outline', b.color ?? 'primary')}>
          <span class="block-box__tab-label">{b.label}</span>
          {b.text && <p class="block-box__text">{b.text}</p>}
        </div>
      ))}
    </div>
  )
}

// ---- D. mindmap ----------------------------------------------------------------

function MindmapNodeView({ node, depth }: { node: MindmapNode; depth: number }) {
  return (
    <div class="block-mindmap__branch" data-depth={depth}>
      <span class="block-pill block-mindmap__node" data-variant={node.variant ?? 'outline'} style={pillStyle(node.variant ?? 'outline', node.color ?? 'primary')}>
        {node.label}
      </span>
      {node.children && node.children.length > 0 && (
        <div class="block-mindmap__children">
          {node.children.map((child, i) => (
            <MindmapNodeView key={i} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  )
}

function MindmapView({ block }: { block: MindmapBlock }) {
  return (
    <div class="block-mindmap">
      <div class="block-mindmap__root">{block.root}</div>
      <div class="block-mindmap__branches">
        {block.branches.map((b, i) => (
          <MindmapNodeView key={i} node={b} depth={0} />
        ))}
      </div>
    </div>
  )
}

// ---- G. comparison -----------------------------------------------------------

function ComparisonView({ block }: { block: ComparisonBlock }) {
  return (
    <div class="block-comparison">
      {[block.left, block.right].map((side, i) => (
        <div key={i} class="block-comparison__side">
          <h3 class="block-comparison__heading">{side.heading}</h3>
          <ul class="block-comparison__bullets">
            {side.bullets.map((bullet, bi) => (
              <li key={bi}>{bullet}</li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}

// ---- F. flow --------------------------------------------------------------------

function FlowView({ block }: { block: FlowBlock }) {
  const direction = block.direction ?? 'vertical'
  return (
    <div class="block-flow" data-direction={direction}>
      {block.steps.map((step, i) => (
        <div key={i} class="block-flow__step-wrap">
          {i > 0 && <span class="block-flow__arrow" aria-hidden="true" />}
          <span
            class="block-pill block-flow__step"
            data-variant={step.variant ?? 'filled'}
            style={pillStyle(step.variant ?? 'filled', step.color ?? 'primary')}
          >
            {step.text}
          </span>
        </div>
      ))}
    </div>
  )
}

// ---- gridHeatmap ------------------------------------------------------------------

function GridHeatmapView({ block }: { block: GridHeatmapBlock }) {
  const legendByKey = new Map(block.legend.map((l) => [l.colorKey, l]))
  const cellByPos = new Map(block.cells.map((c) => [`${c.row}:${c.col}`, c]))
  const cells: JSX.Element[] = []
  for (let r = 0; r < block.rows; r++) {
    for (let c = 0; c < block.cols; c++) {
      const cell = cellByPos.get(`${r}:${c}`)
      const legend = cell ? legendByKey.get(cell.colorKey) : undefined
      cells.push(
        <div
          key={`${r}-${c}`}
          class="block-heatmap__cell"
          data-empty={legend ? undefined : 'true'}
          style={legend ? { background: colorVar(legend.color) } : undefined}
        />,
      )
    }
  }
  return (
    <div class="block-heatmap">
      <div class="block-heatmap__grid" style={{ gridTemplateColumns: `repeat(${block.cols}, 1fr)`, gridTemplateRows: `repeat(${block.rows}, 1fr)` }}>
        {cells}
      </div>
      <div class="block-heatmap__side">
        <ul class="block-legend">
          {block.legend.map((l, i) => (
            <li key={i} class="block-legend__item">
              <i style={{ background: colorVar(l.color) }} />
              <span>{l.label}</span>
            </li>
          ))}
        </ul>
        {block.annotation && <p class="block-heatmap__annotation">{block.annotation}</p>}
      </div>
    </div>
  )
}

// ---- calloutBox -------------------------------------------------------------------

function CalloutBoxView({ block }: { block: CalloutBoxBlock }) {
  const c = colorVar(block.color ?? 'secondary')
  return (
    <div class="block-callout" style={{ borderColor: c }}>
      <h3 class="block-callout__heading" style={{ color: c }}>
        {block.heading}
      </h3>
      <ul class="block-callout__bullets">
        {block.bullets.map((bullet, i) => (
          <li key={i}>
            <Check class="block-callout__check" size={18} strokeWidth={3} style={{ color: c }} aria-hidden="true" />
            <span>{bullet}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ---- paragraph / bulletList / quote / imageRef / visual --------------------------

function QuoteBlockView({ block }: { block: QuoteBlockData }) {
  return (
    <div class="block-quote">
      <p class="block-quote__text">{block.text}</p>
      {block.attribution && <p class="block-quote__attribution">{block.attribution}</p>}
    </div>
  )
}

function ImageRefView({ block }: { block: ImageRefBlock }) {
  return (
    <div class="block-imageref">
      <div class="block-imageref__placeholder">
        <span>{block.caption}</span>
      </div>
      {block.source?.text && (
        <p class="block-imageref__source">
          {block.source.url ? (
            <a href={block.source.url} target="_blank" rel="noreferrer">
              {block.source.text}
            </a>
          ) : (
            block.source.text
          )}
        </p>
      )}
    </div>
  )
}

/** Renders a single ContentBlock. Returns null for unrecognized kinds so a
 * malformed/future block never crashes the whole slide. */
export function BlockView({ block }: { block: ContentBlock }) {
  switch (block.kind) {
    case 'pillRow':
      return <PillRowView block={block} />
    case 'iconRow':
      return <IconRowView block={block} />
    case 'boxGroup':
      return <BoxGroupView block={block} />
    case 'mindmap':
      return <MindmapView block={block} />
    case 'comparison':
      return <ComparisonView block={block} />
    case 'flow':
      return <FlowView block={block} />
    case 'gridHeatmap':
      return <GridHeatmapView block={block} />
    case 'calloutBox':
      return <CalloutBoxView block={block} />
    case 'paragraph':
      return <p class="block-paragraph">{block.text}</p>
    case 'bulletList':
      return (
        <ul class="slide-bullet-list">
          {block.bullets.map((b, i) => (
            <li key={i} class="slide-bullet" data-form={b.form ?? 'noun_phrase'} style={{ '--indent': b.level }}>
              <span class="slide-bullet__marker" />
              <span class="slide-bullet__text">{b.text}</span>
            </li>
          ))}
        </ul>
      )
    case 'quote':
      return <QuoteBlockView block={block} />
    case 'imageRef':
      return <ImageRefView block={block} />
    case 'visual':
      return <SlideVisualBlock visual={block.visual} />
    default:
      return null
  }
}

/** Groups a slide's flat block list into full-width sections and left/right
 * column pairs per §3's `column` placement hint, then renders the whole
 * thing. Consecutive 'left'/'right' blocks are paired into a two-column row;
 * a 'full' (or unset) block flushes any pending pair and renders full width. */
export function BlockStack({ blocks }: { blocks: PositionedBlock[] }) {
  type Group = { kind: 'full'; block: PositionedBlock } | { kind: 'columns'; left: PositionedBlock[]; right: PositionedBlock[] }
  const groups: Group[] = []
  let pendingLeft: PositionedBlock[] = []
  let pendingRight: PositionedBlock[] = []

  const flush = () => {
    if (pendingLeft.length > 0 || pendingRight.length > 0) {
      groups.push({ kind: 'columns', left: pendingLeft, right: pendingRight })
      pendingLeft = []
      pendingRight = []
    }
  }

  for (const block of blocks) {
    if (block.column === 'left') {
      pendingLeft.push(block)
    } else if (block.column === 'right') {
      pendingRight.push(block)
    } else {
      flush()
      groups.push({ kind: 'full', block })
    }
  }
  flush()

  return (
    <div class="block-stack">
      {groups.map((g, i) =>
        g.kind === 'full' ? (
          <div key={i} class="block-stack__full">
            <BlockView block={g.block} />
          </div>
        ) : (
          <div key={i} class="block-stack__columns">
            <div class="block-stack__column">
              {g.left.map((b, bi) => (
                <BlockView key={bi} block={b} />
              ))}
            </div>
            <div class="block-stack__column">
              {g.right.map((b, bi) => (
                <BlockView key={bi} block={b} />
              ))}
            </div>
          </div>
        ),
      )}
    </div>
  )
}

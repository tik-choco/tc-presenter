// Offscreen slide -> PNG rendering for the vision judge (visionJudge.ts).
// Reuses the real SlideView renderer (components/slides) — not a
// reimplementation — so what the vision LLM scores is exactly what a user
// would see in the editor/present tabs, blocks model included. Runs the
// component into a detached, off-viewport DOM node (never visible, no
// layout impact on the actual page) and rasterizes it with html-to-image
// (the one dependency this feature is allowed to add — see the task brief).
//
// Browser-only: `document`/canvas are unavailable in non-DOM contexts (e.g. a
// future headless/node evaluation path). Every export here returns null
// rather than throwing when that's the case, matching this evaluator
// package's "never throw" convention — visionJudge.ts treats null as "vision
// judging unavailable, fall back to the text-only judge".
import { render } from 'preact'
import { toPng } from 'html-to-image'
import SlideView from '../../components/slides/SlideView'
import type { DeckTheme, Slide } from '../../types'

/** Renders `slide` offscreen and returns a PNG data URI, or null if the
 * environment can't render (no DOM) or rasterization fails for any reason
 * (fonts not ready, canvas tainted, etc.) — never throws.
 * `pixelRatio` defaults to 1 (vision-judge use); exporters (lib/export/*)
 * pass a higher value for print-quality output. */
export async function renderSlideToPng(
  slide: Slide,
  theme: DeckTheme,
  pageTotal: number,
  pixelRatio = 1,
): Promise<string | null> {
  if (typeof document === 'undefined') return null

  const host = document.createElement('div')
  host.style.position = 'fixed'
  host.style.top = '0'
  host.style.left = '-10000px'
  host.style.zIndex = '-1'
  host.style.pointerEvents = 'none'
  host.setAttribute('aria-hidden', 'true')
  document.body.appendChild(host)

  try {
    render(<SlideView slide={slide} theme={theme} scale={1} pageTotal={pageTotal} />, host)

    // Let the browser lay out/paint the freshly-mounted DOM (and let
    // web fonts, if any, settle) before rasterizing — a same-tick
    // toPng() call can capture a not-yet-styled frame.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    const fontsReady = (document as Document & { fonts?: { ready?: Promise<unknown> } }).fonts?.ready
    if (fontsReady) await fontsReady.catch(() => undefined)

    const canvasEl = host.querySelector<HTMLElement>('.slide-canvas')
    if (!canvasEl) return null

    return await toPng(canvasEl, { pixelRatio, cacheBust: true, backgroundColor: theme.colorPalette?.background })
  } catch {
    return null
  } finally {
    render(null, host)
    host.remove()
  }
}

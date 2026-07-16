// Deck -> PDF export. Rasterizes each slide with the shared SlideView
// renderer (lib/evaluator/visionRender.renderSlideToPng — the same pipeline
// the vision judge uses, so print output matches what the editor/present
// tabs show) and lays out one full-bleed image per page. jsPDF is loaded via
// a dynamic import so it never inflates the main app bundle.
import { renderSlideToPng } from '../evaluator/visionRender'
import type { Deck } from '../../types'
import { sanitizeFilename } from './filename'
import { pngDataUriToJpeg } from './image'

/** `onProgress(current, total)` fires before each slide is rasterized,
 * 1-based. `signal`, when aborted, stops the export before starting its next
 * slide (or before the final `doc.save`) by throwing a DOMException named
 * 'AbortError' — exportJobs.ts's runJob recognizes that name and settles the
 * job as `cancelled` rather than `failed`. */
export async function exportDeckToPdf(
  deck: Deck,
  onProgress?: (current: number, total: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const { jsPDF } = await import('jspdf')
  const width = 1280
  const height = deck.theme.aspectRatio === '4:3' ? 960 : 720
  const total = deck.slides.length
  const doc = new jsPDF({ orientation: 'landscape', unit: 'px', format: [width, height] })

  for (let i = 0; i < total; i++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const slide = deck.slides[i]
    onProgress?.(i + 1, total)
    if (i > 0) doc.addPage([width, height], 'landscape')

    const png = await renderSlideToPng(slide, deck.theme, total, 2)
    if (png) {
      // Re-encoded to JPEG before embedding — see image.ts's doc comment.
      // Lossless PNGs at 2x pixel density blew a full deck's PDF up to
      // ~100MB+; JPEG cuts that roughly an order of magnitude.
      const jpeg = await pngDataUriToJpeg(png)
      doc.addImage(jpeg, 'JPEG', 0, 0, width, height)
    } else {
      console.error(`exportDeckToPdf: failed to rasterize slide ${slide.index}`)
    }
  }

  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  doc.save(`${sanitizeFilename(deck.title)}.pdf`)
}

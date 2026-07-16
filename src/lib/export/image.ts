// Shared "lossless PNG -> lossy JPEG" re-encode for lib/export/* (pdf.ts,
// pptx.ts). renderSlideToPng (lib/evaluator/visionRender) rasterizes each
// slide at pixelRatio 2 as a PNG — fine for the vision judge, which reads a
// handful of frames, but PNG's lossless encoding makes a full deck's worth
// of full-bleed 2x images balloon a PDF/PPTX into the tens-to-hundreds of
// MB. Re-encoding each slide image as JPEG before embedding cuts that by
// roughly an order of magnitude with no visible quality loss for a slide
// deck (photographic/gradient content compresses especially well; the
// mostly-flat/text-heavy slides this app renders even more so).
export async function pngDataUriToJpeg(dataUri: string, quality = 0.85): Promise<string> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('pngDataUriToJpeg: failed to decode source image'))
    image.src = dataUri
  })

  const canvas = document.createElement('canvas')
  canvas.width = img.naturalWidth
  canvas.height = img.naturalHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('pngDataUriToJpeg: failed to acquire a 2D canvas context')

  // JPEG has no alpha channel — any transparent pixel in the source PNG
  // would otherwise composite onto whatever black-by-default backdrop the
  // encoder picks. Painting a white backdrop first matches this app's
  // slide backgrounds (which are themselves opaque, so this only guards
  // against edge antialiasing/rounding, not visible transparency).
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(img, 0, 0)

  return canvas.toDataURL('image/jpeg', quality)
}

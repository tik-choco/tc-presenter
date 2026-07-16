// Shared "deck title -> safe download filename" helper for lib/export/*
// (pdf.ts, pptx.ts, video.ts) — strips characters that are illegal (or
// awkward) in filenames across Windows/macOS/Linux and caps the length so a
// very long deck title can't produce an unwieldy download name.
export function sanitizeFilename(title: string): string {
  const trimmed = title.trim() || 'deck'
  return trimmed.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120)
}

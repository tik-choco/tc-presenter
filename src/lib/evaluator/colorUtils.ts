// WCAG contrast-ratio math for evaluator metric #10 (contrast_legibility),
// plus a hex-normalizer shared with metric #9 (color_consistency) so both
// compare colors case/format-insensitively.

/** Normalizes "#5A1F35", "5a1f35", "#5A1F35FF" (alpha dropped) to lowercase
 * "#5a1f35" 6-digit form. Returns null if `value` isn't a parseable hex color
 * (3/6/8-digit), so callers can skip non-hex `color` values defensively. */
export function normalizeHex(value: string): string | null {
  const trimmed = value.trim().toLowerCase()
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(trimmed)
  if (!match) return null
  let hex = match[1]
  if (!hex) return null
  if (hex.length === 3) {
    hex = hex
      .split('')
      .map((c) => c + c)
      .join('')
  }
  return `#${hex.slice(0, 6)}`
}

function hexToRgb(hex: string): [number, number, number] | null {
  const normalized = normalizeHex(hex)
  if (!normalized) return null
  const r = parseInt(normalized.slice(1, 3), 16)
  const g = parseInt(normalized.slice(3, 5), 16)
  const b = parseInt(normalized.slice(5, 7), 16)
  return [r, g, b]
}

function toLinear(channel: number): number {
  const c = channel / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** WCAG relative luminance (0-1). Returns null for unparseable hex input. */
export function relativeLuminance(hex: string): number | null {
  const rgb = hexToRgb(hex)
  if (!rgb) return null
  const [r, g, b] = rgb
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b)
}

/** WCAG contrast ratio (1-21) between two colors. Returns null if either hex
 * is unparseable. */
export function contrastRatio(hexA: string, hexB: string): number | null {
  const lA = relativeLuminance(hexA)
  const lB = relativeLuminance(hexB)
  if (lA === null || lB === null) return null
  const lighter = Math.max(lA, lB)
  const darker = Math.min(lA, lB)
  return (lighter + 0.05) / (darker + 0.05)
}

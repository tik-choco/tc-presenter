// Vendored + trimmed from tc-news's src/lib/wireSign.ts. tc-presenter never
// signs a wire of its own — it only verifies wires received from the
// `tc-global-articles` room — so only verifyWire (and the deterministic
// stableStringify it needs to reconstruct the exact bytes that were signed)
// is kept here.
import { isEd25519DidKey, verifyStringWithDid } from './globalArticlesDid'

// Mirrors tc-storage's p2pEnvelope.ts stableStringify(): deterministic,
// key-sorted JSON with undefined fields dropped.
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`
}

function signingPayload(wire: Record<string, unknown>): string {
  const unsigned = { ...wire }
  delete unsigned.signature
  return stableStringify(unsigned)
}

/** Verifies `wire.signature` against every other field, keyed by `wire.fromId`. */
export async function verifyWire(
  wire: Record<string, unknown> & { fromId?: unknown; signature?: unknown },
): Promise<boolean> {
  if (typeof wire.fromId !== 'string' || typeof wire.signature !== 'string') return false
  if (!isEd25519DidKey(wire.fromId)) return false
  try {
    return await verifyStringWithDid(wire.fromId, signingPayload(wire), wire.signature)
  } catch {
    return false
  }
}

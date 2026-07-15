// Tiny JSON-extraction helper shared by this evaluator's one LLM-judge call.
// Local LLMs (Ollama/LM Studio) frequently wrap JSON in prose or a fenced
// code block even when explicitly told "JSON only" — this mirrors the
// tc-news/tc-town `extractJson` pattern (see notes-tc-news.md §4): find the
// first "{" and the last "}" and try to parse that slice, falling back to
// parsing the raw string, and finally to null (never throws).
export function extractJson<T = unknown>(raw: string): T | null {
  const tryParse = (candidate: string): T | null => {
    try {
      return JSON.parse(candidate) as T
    } catch {
      return null
    }
  }

  const direct = tryParse(raw.trim())
  if (direct !== null) return direct

  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null

  return tryParse(raw.slice(start, end + 1))
}

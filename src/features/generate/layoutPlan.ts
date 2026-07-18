// Deterministic, content-aware per-segment block-kind planner. Pure
// functions only (no LLM call) so this is unit-testable in isolation from the
// rest of the generation pipeline.
//
// Why this exists: the previous implementation (generateDeck.ts's
// planLayoutHints/BODY_BLOCK_ROTATION, now removed) rotated through a fixed
// 4-kind cycle (['flow','boxGroup','comparison','pillRow']) regardless of
// what each segment was actually about. A hint that doesn't fit the content
// gets silently overruled by buildSegmentSlideMessages' own "content wins
// over the assignment" line (see prompts.ts's layoutHintLine), so a
// content-blind rotation frequently produced no real variety at all — the
// model just fell back to its own default shape for every segment, which
// tends to look the same slide after slide. This module picks the hint FROM
// the content first, so it actually lands more often, and only falls back to
// anti-monotony rotation when the content gives no signal either way.
//
// Same defensive role as before once a hint IS honored: with
// workerConcurrency > 1, segment slides generate concurrently, so there is no
// sequential previousLayoutSignature to react to — layout_variety protection
// has to be planned up front from the script alone (see generateDeck.ts's
// call site and layout_variety's "3+ consecutive slides with the same
// layout/block kind" doc in README.md).
import type { GenerateOptions } from '../../types'
import type { Script, ScriptSegment } from './parse'

/** Block kinds available to the compact prompt profile (prompts.ts's
 * BLOCK_GUIDE_COMPACT) — a hint must never name a kind the active profile's
 * prompt never described, or the model has nothing to match it against. */
const COMPACT_CANDIDATES = ['flow', 'boxGroup', 'comparison', 'pillRow', 'calloutBox'] as const

/** Full profile adds two more structural kinds (BLOCK_GUIDE's mindmap/
 * iconRow) that compact's trimmed guide never mentions. */
const FULL_CANDIDATES = [...COMPACT_CANDIDATES, 'mindmap', 'iconRow'] as const

type Candidate = (typeof FULL_CANDIDATES)[number]

/** Keyword table (English + Japanese) driving content-based kind selection.
 * Data-driven on purpose — adding/adjusting a kind's trigger words never
 * touches the scoring logic below, only this table. Keywords are matched via
 * plain substring `includes` against the segment's lowercased heading +
 * narration + keyTakeaway, so Japanese entries (unaffected by
 * `toLowerCase()`) and English entries (already lowercase here) both work
 * through the same check. */
const KEYWORD_TABLE: Record<Candidate, string[]> = {
  flow: [
    '手順', 'ステップ', '流れ', 'まず', '次に', '最後に', 'プロセス', '工程', '段階', '順番',
    'step', 'steps', 'process', 'first,', 'then,', 'finally,', 'sequence', 'procedure',
    '①', '②', '③', '④', '⑤',
  ],
  comparison: [
    '比較', '一方', '対して', '従来', '対比', 'メリット', 'デメリット', '前後', '賛否',
    'vs', 'versus', 'before', 'after', 'advantage', 'disadvantage', 'trade-off', 'tradeoff',
    'compare', 'comparison', 'whereas',
  ],
  boxGroup: [
    '構成', '構造', '階層', 'レイヤー', '層', '要素', 'コンポーネント', '内訳',
    'architecture', 'layer', 'layers', 'structure', 'component', 'components', 'consists', 'consist', 'hierarchy',
  ],
  pillRow: [
    '種類', '分類', 'カテゴリ', '要因', 'ポイント', '一覧', 'キーワード',
    'kinds', 'kind', 'categories', 'category', 'factors', 'factor', 'types', 'type', 'keywords', 'keyword', 'list',
  ],
  calloutBox: [
    '要点', '結論', 'まとめ', '重要', '肝', 'キーメッセージ',
    'key point', 'key message', 'takeaway', 'important', 'conclusion', 'in short',
  ],
  mindmap: [
    '全体像', '概要', '目標', '分解', 'ゴール', 'マップ',
    'overview', 'breakdown', 'goals', 'goal', 'big picture', 'roadmap',
  ],
  iconRow: [
    '登場人物', '役割', '対象', '参加者', '関係者',
    'actors', 'actor', 'roles', 'role', 'stakeholders', 'stakeholder', 'participants',
  ],
}

/** Trailing enumeration marker a script writer appends to a multi-part
 * segment's heading (progressive disclosure) — circled digits, or a plain
 * "(2)"/"2" suffix. Stripped before comparing two headings so "アーキテクチャ
 * ②" and "アーキテクチャ③" are recognized as the same topic. */
const CIRCLED_NUMBER_SUFFIX = /[①②③④⑤⑥⑦⑧⑨⑩]\s*$/
const TRAILING_NUMBER_SUFFIX = /[\s]*[(（]?\d+[)）]?\s*$/

function topicKey(heading: string): string {
  return heading.trim().replace(CIRCLED_NUMBER_SUFFIX, '').replace(TRAILING_NUMBER_SUFFIX, '').trim()
}

/** True when two body segments look like consecutive parts of the SAME
 * progressive-disclosure topic (prompts.ts's progressiveDisclosureLine: reuse
 * the preceding slide's structure almost unchanged) rather than unrelated
 * segments that happen to share a block kind. Matches either an identical
 * heading once enumeration suffixes are stripped, or a shared 6+ character
 * prefix (short headings with no common prefix that long are treated as
 * unrelated — 6 chars is enough to avoid coincidental matches on both English
 * and Japanese headings). */
function isSameTopic(headingA: string, headingB: string): boolean {
  const a = topicKey(headingA)
  const b = topicKey(headingB)
  if (!a || !b) return false
  if (a === b) return true
  const prefixLen = 6
  if (a.length < prefixLen || b.length < prefixLen) return false
  return a.slice(0, prefixLen) === b.slice(0, prefixLen)
}

/** Counts keyword matches for `kind` against `text` (already lowercased). */
function scoreKind(kind: Candidate, text: string): number {
  let score = 0
  for (const keyword of KEYWORD_TABLE[kind]) if (text.includes(keyword)) score += 1
  return score
}

/** Least-recently-used tie-breaker: among `pool`, returns whichever kind has
 * the smallest `lastUsedAt` (never-used kinds carry -1, so they always win
 * over anything already used). Ties within `pool` fall back to `pool`'s own
 * order, which is stable across calls. */
function pickLeastRecentlyUsed(pool: readonly Candidate[], lastUsedAt: Map<Candidate, number>): Candidate {
  let best = pool[0]
  let bestAt = lastUsedAt.get(best) ?? -1
  for (const kind of pool) {
    const at = lastUsedAt.get(kind) ?? -1
    if (at < bestAt) {
      best = kind
      bestAt = at
    }
  }
  return best
}

/** Deterministic per-segment block-kind pre-assignment, computed once from
 * the script (the plan) before any slide generates. Only body segments get a
 * hint — intro/conclusion slides already have their own type steering (see
 * buildSegmentSlideMessages' typeHint). The hint is soft: the prompt always
 * tells the model content fit wins over the assignment (layoutHintLine), so
 * this function's job is to land a hint the content actually supports as
 * often as possible, with anti-monotony rotation as a fallback rather than
 * the primary strategy. */
export function planLayoutHints(script: Script, opts: GenerateOptions): (string | undefined)[] {
  const candidates: readonly Candidate[] = opts.promptProfile === 'compact' ? COMPACT_CANDIDATES : FULL_CANDIDATES

  const lastUsedAt = new Map<Candidate, number>(candidates.map((k) => [k, -1]))
  let useCounter = 0
  const markUsed = (kind: Candidate) => {
    lastUsedAt.set(kind, useCounter)
    useCounter += 1
  }

  // Kinds assigned to body segments so far, in emission order (parallel to
  // this function's own progress through script.segments, not to the whole
  // hints array which also holds `undefined` entries for intro/conclusion).
  const bodyAssignments: Candidate[] = []

  const wouldBeThirdConsecutive = (kind: Candidate): boolean =>
    bodyAssignments.length >= 2 &&
    bodyAssignments[bodyAssignments.length - 1] === kind &&
    bodyAssignments[bodyAssignments.length - 2] === kind

  let previousSegment: ScriptSegment | undefined

  const hints = script.segments.map((segment) => {
    if (segment.section !== 'body') {
      previousSegment = segment
      return undefined
    }

    // Progressive disclosure: a continuation of the immediately preceding
    // body segment's topic MUST reuse that segment's kind (prompts.ts's
    // progressiveDisclosureLine expects the same structure repeated with a
    // small addition) — this intentionally bypasses the anti-monotony guard
    // below, since three-in-a-row is exactly right for a 3-part build-up.
    if (previousSegment?.section === 'body' && bodyAssignments.length > 0 && isSameTopic(previousSegment.heading, segment.heading)) {
      const kind = bodyAssignments[bodyAssignments.length - 1]
      bodyAssignments.push(kind)
      markUsed(kind)
      previousSegment = segment
      return kind
    }

    const text = `${segment.heading} ${segment.narration} ${segment.keyTakeaway ?? ''}`.toLowerCase()
    const scored = candidates.map((kind) => ({ kind, score: scoreKind(kind, text) }))
    const maxScore = Math.max(...scored.map((s) => s.score))

    let picked: Candidate
    if (maxScore > 0) {
      // Content gave a signal: restrict to the top-scoring kind(s), and
      // among those prefer whichever avoids a 3rd consecutive repeat. If
      // every top-scoring kind would repeat (e.g. only one kind matched, and
      // it's already run twice), accept the repeat rather than discarding a
      // real content match for a kind the content doesn't support.
      const tied = scored.filter((s) => s.score === maxScore).map((s) => s.kind)
      const nonMonotone = tied.filter((k) => !wouldBeThirdConsecutive(k))
      picked = pickLeastRecentlyUsed(nonMonotone.length > 0 ? nonMonotone : tied, lastUsedAt)
    } else {
      // No keyword decided anything for this segment — pure anti-monotony
      // rotation: least-recently-used kind, excluding an immediate repeat of
      // the previous body segment's kind when another option exists.
      const lastKind = bodyAssignments[bodyAssignments.length - 1]
      const pool = candidates.filter((k) => k !== lastKind)
      picked = pickLeastRecentlyUsed(pool.length > 0 ? pool : candidates, lastUsedAt)
    }

    bodyAssignments.push(picked)
    markUsed(picked)
    previousSegment = segment
    return picked
  })

  return hints
}

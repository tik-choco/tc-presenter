// Rule-based narration-script quality checks (no LLM call, no Preact — pure
// and unit-testable, same philosophy as generateDeck.ts's identifyWeakSlides
// for individual slides). Runs once per freshly-generated script, right after
// generateScript() and BEFORE that script is committed as the checkpoint
// payload (see generateDeck.ts's top-of-pipeline integration) — the script is
// the single source every per-segment slide is visualized from, so a
// structural defect caught here (and, ideally, fixed by one bounded LLM
// repair call) is far cheaper than letting it propagate into every slide and
// relying on the per-slide refine loop to notice something is off.
//
// Every rule below detects a concrete deviation from buildScriptMessages'
// contract (prompts.ts): the exact-one-intro/-conclusion structure, the
// 80-200-word natural-spoken-sentence narration requirement, the chapter-
// grouping instruction for >6 body segments, etc. Issue strings are English
// (fed verbatim into buildScriptRefineMessages' feedback list, same
// convention as identifyWeakSlides' issue strings) and are written as
// actionable fix instructions, not just descriptions of the problem.
import type { Script, ScriptSegment } from './parse'

export interface ScriptIssue {
  /** 0-based index into Script.segments this issue is about; omitted for
   * deck-level issues (title, intro/conclusion/body counts, chapter
   * consistency across segments). */
  segmentIndex?: number
  /** English, LLM-refine-prompt-ready description of the problem and how to
   * fix it. */
  issue: string
}

const MAX_TITLE_CHARS = 30
// buildScriptMessages asks for "80-200 words of natural, complete spoken
// sentences" per segment; 50 characters is well short of even a single such
// sentence, so anything under it reads as a stub/fragment rather than a
// short-but-valid narration.
const MIN_NARRATION_CHARS = 50
const MAX_NARRATION_CHARS = 800
const MAX_HEADING_CHARS = 25
const MAX_TAKEAWAY_CHARS = 60
// buildScriptMessages: "if you write MORE THAN 6 body segments, group them
// into 2-5 chapters" — so the all-chapters-empty check only fires at 7+.
const MIN_BODY_SEGMENTS_FOR_CHAPTERS = 7

/** Matches a line that reads as an outline/bullet fragment rather than a
 * spoken sentence: a leading dash/bullet glyph, a circled number (①-⑩), or a
 * "1." / "1)" / "1、" numbered-list marker. */
const OUTLINE_LINE = /^\s*(?:[-*・•]|[①②③④⑤⑥⑦⑧⑨⑩]|\d+[.)、])\s*/

/** True when a majority of the narration's non-empty lines look like outline
 * items rather than prose — buildScriptMessages requires "the actual words to
 * be spoken aloud — not an outline, not bullet fragments" since this text
 * becomes the slide's speakerNotes verbatim. A single short narration (one
 * line) never trips this; it only matters once there's more than one line to
 * compare. */
function looksLikeOutline(narration: string): boolean {
  const lines = narration
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  if (lines.length < 2) return false
  const outlineLines = lines.filter((l) => OUTLINE_LINE.test(l)).length
  return outlineLines > lines.length / 2
}

function checkSegment(segment: ScriptSegment, index: number): ScriptIssue[] {
  const issues: ScriptIssue[] = []
  const heading = segment.heading.trim()
  const narration = segment.narration.trim()

  if (!heading) {
    issues.push({ segmentIndex: index, issue: 'Heading is empty — give this segment a short, specific slide title.' })
  } else if (heading.length > MAX_HEADING_CHARS) {
    issues.push({ segmentIndex: index, issue: `Heading is too long (${heading.length} characters) — shorten it to roughly 10-25 characters.` })
  }

  if (!narration) {
    issues.push({ segmentIndex: index, issue: 'Narration is empty — write the full spoken text for this segment (80-200 words of natural, complete sentences).' })
  } else {
    if (narration.length < MIN_NARRATION_CHARS) {
      issues.push({
        segmentIndex: index,
        issue: `Narration is too short (${narration.length} characters) — write 80-200 words of natural, complete spoken sentences, not a fragment.`,
      })
    } else if (narration.length > MAX_NARRATION_CHARS) {
      issues.push({
        segmentIndex: index,
        issue: `Narration is too long (${narration.length} characters) — tighten it toward 80-200 words; split into additional segments if the topic genuinely needs more room.`,
      })
    }
    if (looksLikeOutline(narration)) {
      issues.push({
        segmentIndex: index,
        issue: 'Narration reads as a bullet/outline list, not spoken sentences — rewrite it as natural, complete spoken sentences (this text is used verbatim as the slide\'s speaker notes).',
      })
    }
  }

  const keyTakeaway = segment.keyTakeaway?.trim() ?? ''
  if (!keyTakeaway) {
    issues.push({
      segmentIndex: index,
      issue: 'keyTakeaway is missing — add one sentence (~40 characters or fewer) stating this segment\'s implication/conclusion, never a paraphrase of the narration.',
    })
  } else if (keyTakeaway.length > MAX_TAKEAWAY_CHARS) {
    issues.push({ segmentIndex: index, issue: `keyTakeaway is too long (${keyTakeaway.length} characters) — shorten it to roughly 40 characters or fewer.` })
  }

  return issues
}

export function checkScript(script: Script): ScriptIssue[] {
  const issues: ScriptIssue[] = []

  const title = script.title.trim()
  if (!title) {
    issues.push({ issue: 'Deck title is empty — give the deck a punchy title, ~10-20 characters.' })
  } else if (title.length > MAX_TITLE_CHARS) {
    issues.push({ issue: `Deck title is too long (${title.length} characters) — shorten it to roughly 10-20 characters.` })
  }

  const introCount = script.segments.filter((s) => s.section === 'intro').length
  const conclusionCount = script.segments.filter((s) => s.section === 'conclusion').length
  const bodyCount = script.segments.filter((s) => s.section === 'body').length

  if (introCount !== 1) issues.push({ issue: `Script must have exactly ONE "intro" segment (found ${introCount}).` })
  if (conclusionCount !== 1) issues.push({ issue: `Script must have exactly ONE "conclusion" segment (found ${conclusionCount}).` })
  if (bodyCount === 0) issues.push({ issue: 'Script has no "body" segments — add at least one body segment covering the main content.' })

  script.segments.forEach((segment, index) => issues.push(...checkSegment(segment, index)))

  // Heading duplicates (trimmed, exact match): two segments sharing a heading
  // produce two identically-titled slides downstream (title_uniqueness).
  // dedupeTitles in generateDeck.ts already patches this mechanically at the
  // slide level, but catching it here lets the LLM pick a genuinely distinct
  // title instead of a circled-number suffix.
  const firstIndexByHeading = new Map<string, number>()
  script.segments.forEach((segment, index) => {
    const heading = segment.heading.trim()
    if (!heading) return
    const firstIndex = firstIndexByHeading.get(heading)
    if (firstIndex === undefined) {
      firstIndexByHeading.set(heading, index)
    } else {
      issues.push({
        segmentIndex: index,
        issue: `Heading "${heading}" duplicates segment ${firstIndex + 1}'s heading — give this segment a distinct, specific title.`,
      })
    }
  })

  // Chapter-grouping consistency (buildScriptMessages' grouping rule).
  if (bodyCount >= MIN_BODY_SEGMENTS_FOR_CHAPTERS) {
    const allChaptersEmpty = script.segments.every((s) => s.section !== 'body' || !s.chapter?.trim())
    if (allChaptersEmpty) {
      issues.push({ issue: `Script has ${bodyCount} body segments but none carry a "chapter" label — group them into 2-5 chapters as instructed.` })
    }
  }

  // Interleaving: the same chapter label reappearing after another chapter
  // started — buildScriptMessages requires chapter membership to be
  // consecutive-only ("never interleave two chapters").
  {
    const seenChapters = new Set<string>()
    let lastChapter: string | undefined
    script.segments.forEach((segment, index) => {
      if (segment.section !== 'body') return
      const chapter = segment.chapter?.trim()
      if (!chapter) {
        lastChapter = undefined
        return
      }
      if (chapter !== lastChapter && seenChapters.has(chapter)) {
        issues.push({
          segmentIndex: index,
          issue: `Chapter "${chapter}" is interleaved with other chapters — segments belonging to the same chapter must be consecutive, never split apart by a different chapter.`,
        })
      }
      seenChapters.add(chapter)
      lastChapter = chapter
    })
  }

  // intro/conclusion segments are never chapter members (buildScriptMessages:
  // "always [leave chapter empty] for intro/conclusion segments").
  script.segments.forEach((segment, index) => {
    if (segment.section !== 'body' && segment.chapter?.trim()) {
      issues.push({
        segmentIndex: index,
        issue: `"${segment.section}" segments must not have a "chapter" label (found "${segment.chapter.trim()}") — clear it.`,
      })
    }
  })

  return issues
}

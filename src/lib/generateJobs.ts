// Background deck-generation job queue: serial (concurrency fixed at 1),
// module-scope singleton + pub/sub, following the subscribe*/load* pattern
// of lib/llmConfig.ts (subscribeLlmConfig) rather than React state — so job
// state (and the in-flight generateDeck() call itself) survives
// features/editor's tab being unmounted. app.tsx renders tabs via a
// condition (`{tab === 'editor' && <EditorTab .../>}`), which really
// unmounts the inactive tab; EditorTab previously kept `busy`/`progress` as
// local useState and awaited generateDeck(...) directly inside its submit
// handler, so switching tabs mid-generation silently dropped the progress UI
// and nothing prevented starting a second generation concurrently. Hoisting
// both the job list and the generateDeck() call up to this module fixes
// both: the queue keeps running (and keeps its state) regardless of which
// tab is mounted, and only one generation runs at a time.
//
// TS port of tc-pdf-viewer/src/App.jsx's in-component AI job queue
// (nextAiJobIdRef / aiJobsRef / activeAiJobRef / aiJobControllersRef +
// processAiQueue / enqueueAiJob / cancelAiJob) — same queued -> running ->
// complete/failed/cancelled state machine and the same
// AbortController-per-job cancellation, but as a module-scope singleton
// instead of per-component refs/state, and generalized to "one job kind"
// (deck generation) rather than tc-pdf-viewer's OCR/translation union.
//
// Dependency direction note: this file lives in lib/ and generally shouldn't
// depend on features/, but `generateDeck`'s only implementation is
// features/generate/generateDeck.ts (re-exported from features/generate's
// barrel) — there's no lib/-side copy to call instead, so that one import is
// an accepted exception. `evaluateDeck`, by contrast, already lives at
// lib/evaluator (features/generate/index.ts merely re-exports it for
// features/editor's convenience), so it's imported directly from
// './evaluator' here rather than through features/generate, keeping the
// features/-facing surface to the single unavoidable import.
import { generateDeck } from '../features/generate'
import { evaluateDeck } from './evaluator'
import { saveDeck } from './kv'
import {
  commitRefined,
  commitScript,
  commitSlide,
  createCheckpoint,
  deleteCheckpoint,
  listCheckpoints,
  loadCheckpoint,
  newJobKey,
  sweepCheckpoints,
} from './generateCheckpoint'
import type { DeckScore, DeckTheme, GenerateOptions, GenerateProgressEvent, SourceMaterial } from '../types'

/** How long a `complete`/`cancelled` job stays visible after settling before
 * being dropped from `jobs` automatically. `failed` jobs are exempt (see
 * `scheduleRemoval`) — a failure should stay visible until the user
 * dismisses it, since there's no other affordance to notice/read the error. */
const RETENTION_MS = 15_000

export type GenerateJobStatus = 'queued' | 'running' | 'cancelling' | 'complete' | 'failed' | 'cancelled'

export interface GenerateJob {
  id: number
  /** lib/generateCheckpoint.ts上の永続チェックポイントのキー。`id`はセッション
   * ローカルな連番でしかないのに対し、こちらはセッションを跨いで安定 —
   * 中断ジョブの再開(resumeGenerateJob)はこのキーで復元する。 */
  jobKey: string
  /** 表示用ラベル(呼び出し側が先頭ソースのタイトル等を渡す) */
  label: string
  sources: SourceMaterial[] // スナップショット
  opts: GenerateOptions // スナップショット(signalは含まない)
  /** 完了時にdeck.themeへ適用するテーマ(default時はundefined) */
  theme: DeckTheme | undefined
  status: GenerateJobStatus
  progress: GenerateProgressEvent | null
  error: string | null
  deckId: string | null // complete時にセット
  score: DeckScore | null // complete後の評価結果(ベストエフォート)
  createdAt: number
  updatedAt: number
  startedAt: number | null
}

let jobs: GenerateJob[] = []
let nextJobId = 1
let activeJobId: number | null = null

const listeners = new Set<() => void>()
const controllers = new Map<number, AbortController>()

function notify(): void {
  for (const listener of listeners) listener()
}

/** Replaces `jobs` wholesale (never mutated in place) and notifies
 * subscribers. Every other function in this module funnels its writes
 * through here so `getGenerateJobs()` can hand back the same array
 * reference whenever nothing has actually changed. */
function updateJobs(updater: (current: GenerateJob[]) => GenerateJob[]): void {
  jobs = updater(jobs)
  notify()
}

function patchJob(id: number, patch: Partial<GenerateJob>): void {
  updateJobs((current) => current.map((job) => (job.id === id ? { ...job, ...patch, updatedAt: Date.now() } : job)))
}

function scheduleRemoval(id: number): void {
  setTimeout(() => {
    updateJobs((current) => current.filter((job) => job.id !== id))
  }, RETENTION_MS)
}

/** `generateDeck`/`evaluateDeck` are documented to never throw on their own
 * (every internal LLM call is individually caught and degrades to a
 * placeholder) — but aborting a job's `AbortController` can still surface as
 * a rejection from underneath (fetch's own AbortError, or a signal check
 * somewhere in the pipeline), so the runner below treats any such rejection
 * defensively as a cancellation rather than a generation failure. */
function isAbortError(err: unknown): boolean {
  if (err instanceof Error) return err.name === 'AbortError' || /cancel|abort/i.test(err.message)
  return typeof err === 'string' && /cancel|abort/i.test(err)
}

async function runJob(job: GenerateJob, signal: AbortSignal): Promise<void> {
  try {
    const generated = await generateDeck(job.sources, { ...job.opts, signal }, (evt) => {
      patchJob(job.id, { progress: evt })
      // Checkpoint commits (lib/generateCheckpoint.ts): each event that
      // carries a commit payload persists that atomic unit of progress, so a
      // crash/cancel from here on can resume instead of restarting. Fallback
      // slides are deliberately NOT committed — a resume should retry them
      // (see GenerateProgressEvent.slideIsFallback's doc).
      if (evt.script) commitScript(job.jobKey, evt.script)
      if (evt.slide && evt.segmentIndex !== undefined && !evt.slideIsFallback) {
        commitSlide(job.jobKey, evt.segmentIndex, evt.slide)
      }
      if (evt.refinedDeck && evt.iteration !== undefined && evt.iteration > 0) {
        commitRefined(job.jobKey, evt.refinedDeck, evt.iteration)
      }
    })
    const themed = job.theme ? { ...generated, theme: job.theme } : generated
    const stamped = { ...themed, updatedAt: new Date().toISOString() }
    saveDeck(stamped)
    // Atomic promotion: the finished deck enters the kv.ts library in one
    // saveDeck, and only then is the (now redundant) checkpoint dropped —
    // the library never sees a half-generated deck.
    deleteCheckpoint(job.jobKey)
    patchJob(job.id, { status: 'complete', deckId: stamped.id })
    scheduleRemoval(job.id)

    try {
      const score = await evaluateDeck(stamped, {
        useLlmJudge: job.opts.useLlmJudge,
        useVisionJudge: job.opts.useVisionJudge,
        visionPresetId: job.opts.visionPresetId,
        // Same preset routing as generateDeck's in-pipeline evaluation:
        // plan_fanout reserves the orchestrator preset for the plan call, so
        // this final score runs on the worker preset there.
        presetId:
          job.opts.pipelineMode === 'plan_fanout' ? (job.opts.workerPresetId ?? job.opts.presetId) : job.opts.presetId,
        connection: job.opts.connection,
      })
      patchJob(job.id, { score })
    } catch {
      // Score display is best-effort — generation itself already succeeded
      // and was saved, so a failed/unconfigured evaluator shouldn't sour the
      // job's outcome.
    }
  } catch (err) {
    // Both settle paths deliberately KEEP the job's checkpoint: cancelled and
    // failed runs are exactly the ones worth resuming (listResumable
    // GenerateJobs / resumeGenerateJob below). Unresumed checkpoints expire
    // via sweepCheckpoints' retention window.
    if (isAbortError(err)) {
      patchJob(job.id, { status: 'cancelled', error: null })
      scheduleRemoval(job.id)
    } else {
      patchJob(job.id, { status: 'failed', error: err instanceof Error ? err.message : String(err) })
      // Not scheduled for auto-removal — see RETENTION_MS's doc comment.
    }
  }
}

/** Starts the next queued job if the single execution slot is free. A no-op
 * if a job is already running or nothing is queued. Each call handles at
 * most one job; the next one is picked up via the `.finally()` below, which
 * fires after `runJob` (generation, save, and the best-effort evaluate) has
 * fully settled — so only one deck is ever being generated at a time. */
function processQueue(): void {
  if (activeJobId !== null) return
  const next = jobs.find((job) => job.status === 'queued')
  if (!next) return

  const controller = new AbortController()
  activeJobId = next.id
  controllers.set(next.id, controller)
  patchJob(next.id, { status: 'running', startedAt: Date.now() })

  runJob(next, controller.signal).finally(() => {
    activeJobId = null
    controllers.delete(next.id)
    processQueue()
  })
}

/** Queues a new deck-generation job (serial: it runs once every
 * earlier-queued job has finished) and returns its id. `input.sources`/
 * `input.opts` are snapshotted as-is at call time — later mutating the
 * caller's arrays/objects has no effect on the queued job.
 *
 * `input.jobKey` is for resumeGenerateJob only: it re-attaches the job to an
 * EXISTING checkpoint instead of creating a fresh one, so the resumed run
 * keeps committing into the same record. Regular callers omit it. */
export function enqueueGenerateJob(input: {
  label: string
  sources: SourceMaterial[]
  opts: GenerateOptions
  theme?: DeckTheme
  jobKey?: string
}): number {
  const id = nextJobId
  nextJobId += 1
  const now = Date.now()

  const jobKey = input.jobKey ?? newJobKey()
  if (!input.jobKey) {
    createCheckpoint({ jobKey, label: input.label, opts: input.opts, theme: input.theme, sources: input.sources })
  }

  const job: GenerateJob = {
    id,
    jobKey,
    label: input.label,
    sources: input.sources,
    opts: input.opts,
    theme: input.theme,
    status: 'queued',
    progress: null,
    error: null,
    deckId: null,
    score: null,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
  }

  updateJobs((current) => [...current, job])
  processQueue()
  return id
}

// ---------------------------------------------------------------------------
// Resume: checkpoints left behind by interrupted runs (tab closed, crash,
// cancel, failure) can be picked back up — generateDeck reuses the committed
// script and slides verbatim and only regenerates the holes.

/** Summary of one resumable checkpoint, for a "再開しますか?" UI. */
export interface ResumableGenerateJob {
  jobKey: string
  label: string
  updatedAt: string
  /** Committed / total segment-slide counts (0/0 until the script commits). */
  doneSegments: number
  segmentCount: number
}

/** Checkpoints not owned by any job in the current session's queue, newest
 * first. Best-effort: storage errors yield an empty list, never a throw. */
export async function listResumableGenerateJobs(): Promise<ResumableGenerateJob[]> {
  try {
    const activeKeys = new Set(jobs.map((j) => j.jobKey))
    const manifests = await listCheckpoints()
    return manifests
      .filter((m) => !activeKeys.has(m.jobKey))
      .map((m) => ({
        jobKey: m.jobKey,
        label: m.label,
        updatedAt: m.updatedAt,
        doneSegments: m.doneSegments.length,
        segmentCount: m.segmentCount,
      }))
  } catch {
    return []
  }
}

/** Re-queues an interrupted generation from its checkpoint. Returns false
 * (and drops the unusable checkpoint) when there's nothing to resume. A
 * checkpoint that died before its script committed simply restarts from
 * scratch — under the same jobKey, so its record is reused, not duplicated. */
export async function resumeGenerateJob(jobKey: string): Promise<boolean> {
  if (jobs.some((j) => j.jobKey === jobKey)) return false // already queued/running
  const loaded = await loadCheckpoint(jobKey)
  if (!loaded) {
    deleteCheckpoint(jobKey)
    notify() // resumable listings derive from subscriber notifications — refresh them
    return false
  }
  const opts: GenerateOptions = { ...loaded.manifest.opts }
  if (loaded.resume) opts.resume = loaded.resume
  enqueueGenerateJob({
    label: loaded.manifest.label,
    sources: loaded.sources,
    opts,
    theme: loaded.manifest.theme,
    jobKey,
  })
  return true
}

/** Permanently discards a resumable checkpoint (the "破棄" button). */
export function discardResumableGenerateJob(jobKey: string): void {
  deleteCheckpoint(jobKey)
  notify()
}

// Startup GC: at module load no session job exists yet, so every checkpoint
// on disk is by definition interrupted — sweep only expired/corrupt ones and
// leave the rest for the resume UI.
sweepCheckpoints()

/**
 * Cancels/dismisses a job, behavior depending on its current status:
 * - `queued`: cancelled immediately (never started).
 * - `running`: marked `cancelling` and its `AbortController` is aborted;
 *   `runJob`'s catch settles it to `cancelled` once the abort is observed.
 * - `cancelling`: no-op (an abort is already in flight).
 * - `complete`/`failed`/`cancelled` (i.e. already terminal): removed from
 *   `jobs` immediately — this is how a UI "✕" button doubles as dismissing
 *   a finished job, `failed` included, without a separate API.
 * Unknown ids are ignored.
 */
export function cancelGenerateJob(id: number): void {
  const job = jobs.find((j) => j.id === id)
  if (!job) return

  switch (job.status) {
    case 'queued':
      patchJob(id, { status: 'cancelled' })
      scheduleRemoval(id)
      return
    case 'running':
      patchJob(id, { status: 'cancelling' })
      controllers.get(id)?.abort()
      return
    case 'cancelling':
      return
    case 'complete':
    case 'failed':
    case 'cancelled':
      updateJobs((current) => current.filter((j) => j.id !== id))
      return
  }
}

/** Subscribes to any change in the job queue (enqueue, status/progress
 * patch, or removal). Returns an unsubscribe function. Mirrors
 * lib/llmConfig.ts's `subscribeLlmConfig` shape, minus the cross-tab
 * `storage` event — this queue is same-tab/module-scope only. */
export function subscribeGenerateJobs(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Immutable snapshot of the current queue. Returns the same array reference
 * across calls when nothing has changed (every mutation in this module
 * replaces `jobs` wholesale rather than mutating in place), so callers can
 * use it directly as a `useSyncExternalStore`-style snapshot. */
export function getGenerateJobs(): GenerateJob[] {
  return jobs
}

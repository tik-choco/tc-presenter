// Background export job queue: PDF/PPTX/video exports run serially (one at
// a time, concurrency fixed at 1) as a module-scope singleton + pub/sub —
// same shape as lib/generateJobs.ts (updateJobs/patchJob/notify,
// scheduleRemoval, processQueue, one AbortController per job, isAbortError),
// so job state survives the initiating tab being unmounted and the same
// queued -> running -> complete/failed/cancelled state machine applies here
// too. Unlike generateJobs, there is no checkpoint/resume mechanism: an
// aborted or failed export has nothing worth resuming from mid-slide (no
// partial PDF/PPTX/video is usable), so cancelling or retrying always means
// starting a fresh job from slide 1.
//
// This queue's execution slot is independent of generateJobs' — an export
// and a generation can run concurrently; only two exports (or two
// generations) can't run concurrently with each other. Video export in
// particular uses MediaRecorder to capture a live canvas+audio recording in
// real time, so two video jobs sharing one slot also means only one
// recording is ever in flight at once.
import type { Deck } from '../types'

/** How long a `complete`/`cancelled` job stays visible after settling before
 * being dropped from `jobs` automatically. `failed` jobs are exempt (see
 * `scheduleRemoval`) — a failure should stay visible until the user
 * dismisses it, since there's no other affordance to notice/read the error. */
const RETENTION_MS = 15_000

export type ExportKind = 'pdf' | 'pptx' | 'video'
export type ExportJobStatus = 'queued' | 'running' | 'cancelling' | 'complete' | 'failed' | 'cancelled'

export interface ExportJob {
  id: number
  kind: ExportKind
  /** 表示用ラベル(enqueue時の deck.title) */
  label: string
  status: ExportJobStatus
  /** 処理中スライド番号(1-based、exporter の onProgress をそのまま反映)。開始前は0。 */
  current: number
  total: number
  error: string | null
  createdAt: number
  updatedAt: number
  startedAt: number | null
}

/** Internal-only job shape: carries the deck snapshot the public `ExportJob`
 * deliberately omits (the UI has no use for the full deck, only its
 * progress/status), plus the job's own AbortController. */
interface InternalExportJob extends ExportJob {
  deck: Deck
}

let jobs: InternalExportJob[] = []
let nextJobId = 1
let activeJobId: number | null = null

const listeners = new Set<() => void>()
const controllers = new Map<number, AbortController>()

function notify(): void {
  for (const listener of listeners) listener()
}

/** Replaces `jobs` wholesale (never mutated in place) and notifies
 * subscribers. Every other function in this module funnels its writes
 * through here so `getExportJobs()` can hand back the same array reference
 * whenever nothing has actually changed. */
function updateJobs(updater: (current: InternalExportJob[]) => InternalExportJob[]): void {
  jobs = updater(jobs)
  notify()
}

function patchJob(id: number, patch: Partial<InternalExportJob>): void {
  updateJobs((current) => current.map((job) => (job.id === id ? { ...job, ...patch, updatedAt: Date.now() } : job)))
}

function scheduleRemoval(id: number): void {
  setTimeout(() => {
    updateJobs((current) => current.filter((job) => job.id !== id))
  }, RETENTION_MS)
}

/** Aborting a job's `AbortController` can surface as a rejection from
 * underneath (the exporter's own DOMException('AbortError'), or some other
 * cancel-flavored rejection along the way) rather than a clean return, so
 * the runner below treats any such rejection defensively as a cancellation
 * rather than an export failure. Mirrors generateJobs.ts's isAbortError. */
function isAbortError(err: unknown): boolean {
  if (err instanceof Error) return err.name === 'AbortError' || /cancel|abort/i.test(err.message)
  return typeof err === 'string' && /cancel|abort/i.test(err)
}

async function runJob(job: InternalExportJob, signal: AbortSignal): Promise<void> {
  try {
    const onProgress = (current: number, total: number): void => {
      patchJob(job.id, { current, total })
    }
    switch (job.kind) {
      case 'pdf': {
        const { exportDeckToPdf } = await import('./export/pdf')
        await exportDeckToPdf(job.deck, onProgress, signal)
        break
      }
      case 'pptx': {
        const { exportDeckToPptx } = await import('./export/pptx')
        await exportDeckToPptx(job.deck, onProgress, signal)
        break
      }
      case 'video': {
        const { exportDeckToVideo } = await import('./export/video')
        await exportDeckToVideo(job.deck, onProgress, signal)
        break
      }
    }
    patchJob(job.id, { status: 'complete' })
    scheduleRemoval(job.id)
  } catch (err) {
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
 * fires after `runJob` has fully settled — so only one export is ever
 * running at a time. */
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

/** Queues a new export job (serial: it runs once every earlier-queued export
 * job has finished) and returns its id. `deck` is snapshotted as-is at call
 * time — later mutating the caller's deck object has no effect on the
 * queued job. */
export function enqueueExportJob(kind: ExportKind, deck: Deck): number {
  const id = nextJobId
  nextJobId += 1
  const now = Date.now()

  const job: InternalExportJob = {
    id,
    kind,
    label: deck.title,
    deck,
    status: 'queued',
    current: 0,
    total: deck.slides.length,
    error: null,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
  }

  updateJobs((current) => [...current, job])
  processQueue()
  return id
}

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
export function cancelExportJob(id: number): void {
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
 * generateJobs.ts's `subscribeGenerateJobs` — same-tab/module-scope only. */
export function subscribeExportJobs(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Immutable snapshot of the current queue. The return type omits each
 * job's internal `deck` snapshot (the UI has no use for it — only status/
 * progress) even though the underlying objects still carry it; callers
 * should go through the `ExportJob` type rather than reaching past it.
 * Returns the same array reference across calls when nothing has changed
 * (every mutation in this module replaces `jobs` wholesale rather than
 * mutating in place), so callers can use it directly as a
 * `useSyncExternalStore`-style snapshot. */
export function getExportJobs(): ExportJob[] {
  return jobs
}

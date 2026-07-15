// Cross-tab toast showing deck-generation job progress. Mounted once at the
// app shell level (outside the tab switch in app.tsx) so it stays visible
// regardless of which tab the user is on. Reads/writes lib/generateJobs.ts's
// module-level job queue (see that file's public API contract) — this
// component owns no state of its own beyond a subscribed snapshot.
//
// Modeled on tc-pdf-viewer's `.ai-queue-toast` (src/App.jsx +
// src/index.css): fixed bottom-right stack of job rows, each cancellable.
// `cancelGenerateJob` doubles as "cancel" (queued/running) and "dismiss"
// (terminal states) per its contract, so a single ✕ button covers every
// status.
import { useEffect, useState } from 'preact/hooks'
import { X } from 'lucide-preact'
import './generate-queue-toast.css'
import { t } from '../i18n'
import {
  cancelGenerateJob,
  discardResumableGenerateJob,
  getGenerateJobs,
  listResumableGenerateJobs,
  resumeGenerateJob,
  subscribeGenerateJobs,
  type GenerateJob,
  type ResumableGenerateJob,
} from '../lib/generateJobs'

const MAX_VISIBLE = 4

interface GenerateQueueToastProps {
  onOpenDeck: (deckId: string) => void
}

function statusText(job: GenerateJob): string {
  switch (job.status) {
    case 'queued':
      return t('queue.queued')
    case 'running': {
      if (!job.progress) return t('queue.queued')
      const stage = t(`editor.progress.stage.${job.progress.stage}`)
      // Per-slide progress ("3/12") while segment slides stream in — the
      // partial-atomicity pipeline reports each committed slide as it lands.
      if (job.progress.stage === 'slides' && job.progress.segmentsTotal) {
        return `${stage} · ${job.progress.segmentsDone ?? 0}/${job.progress.segmentsTotal}`
      }
      if (job.progress.iteration !== undefined) {
        return `${stage} · ${t('editor.progress.iteration', { iteration: job.progress.iteration })}`
      }
      return stage
    }
    case 'cancelling':
      return t('queue.cancelling')
    case 'complete':
      return t('queue.complete')
    case 'failed':
      return t('queue.failed')
    case 'cancelled':
      return t('queue.cancelled')
    default:
      return ''
  }
}

export default function GenerateQueueToast({ onOpenDeck }: GenerateQueueToastProps) {
  const [jobs, setJobs] = useState<GenerateJob[]>(() => getGenerateJobs())
  const [resumables, setResumables] = useState<ResumableGenerateJob[]>([])

  useEffect(() => subscribeGenerateJobs(() => setJobs(getGenerateJobs())), [])

  // Interrupted generations left on disk by a previous session (or a
  // cancel/failure in this one). Refreshed on every queue change — resuming
  // moves an entry into `jobs`, and settling a job may add one.
  useEffect(() => {
    let alive = true
    const refresh = () => {
      void listResumableGenerateJobs().then((list) => {
        if (alive) setResumables(list)
      })
    }
    refresh()
    const unsubscribe = subscribeGenerateJobs(refresh)
    return () => {
      alive = false
      unsubscribe()
    }
  }, [])

  if (jobs.length === 0 && resumables.length === 0) return null

  const visible = jobs.slice(0, MAX_VISIBLE)
  const overflow = jobs.length - visible.length

  return (
    <div class="gqt-toast" role="status" aria-live="polite">
      <div class="gqt-header">{t('queue.title')}</div>
      {resumables.length > 0 && (
        <div class="gqt-resume">
          <div class="gqt-resume__header">{t('queue.resumable')}</div>
          {resumables.map((r) => (
            <div key={r.jobKey} class="gqt-item gqt-item--resumable">
              <div class="gqt-item__main">
                <div class="gqt-item__label" title={r.label}>
                  {r.label}
                </div>
                <div class="gqt-item__status">
                  {r.segmentCount > 0
                    ? t('queue.resumeProgress', { done: r.doneSegments, total: r.segmentCount })
                    : t('queue.queued')}
                </div>
              </div>
              <div class="gqt-item__actions">
                <button type="button" class="gqt-open" onClick={() => void resumeGenerateJob(r.jobKey)}>
                  {t('queue.resume')}
                </button>
                <button
                  type="button"
                  class="gqt-cancel"
                  onClick={() => discardResumableGenerateJob(r.jobKey)}
                  aria-label={t('queue.discard')}
                  title={t('queue.discard')}
                >
                  <X size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      <div class="gqt-list">
        {visible.map((job) => (
          <div key={job.id} class={`gqt-item gqt-item--${job.status}`}>
            <div class="gqt-item__main">
              <div class="gqt-item__label" title={job.label}>
                {job.label}
              </div>
              <div class="gqt-item__status">
                {job.status === 'running' && <span class="gqt-spinner" />}
                <span>{statusText(job)}</span>
              </div>
              {job.status === 'failed' && job.error && (
                <div class="gqt-item__error" title={job.error}>
                  {job.error}
                </div>
              )}
            </div>
            <div class="gqt-item__actions">
              {job.status === 'complete' && (
                <>
                  {job.score && <span class="gqt-score">{Math.round(job.score.total)}</span>}
                  <button
                    type="button"
                    class="gqt-open"
                    onClick={() => job.deckId && onOpenDeck(job.deckId)}
                  >
                    {t('queue.open')}
                  </button>
                </>
              )}
              <button
                type="button"
                class="gqt-cancel"
                onClick={() => cancelGenerateJob(job.id)}
                aria-label={t('queue.cancel')}
                title={t('queue.cancel')}
              >
                <X size={14} />
              </button>
            </div>
          </div>
        ))}
      </div>
      {overflow > 0 && <div class="gqt-overflow">{t('queue.overflow', { count: overflow })}</div>}
    </div>
  )
}

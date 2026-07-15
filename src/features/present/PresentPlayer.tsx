// The auto-presentation player (PLAN.md: `<PresentPlayer deck onExit />`).
// Renders the current slide full-screen via components/slides/SlideView,
// synthesizes each slide's speakerNotes through lib/tts.ts and plays it,
// auto-advancing to the next slide/buildStage when narration ends. When TTS
// is unconfigured or a synthesis call fails, falls back to an
// estimated-reading-time auto-advance timer (configurable chars/second) so
// the deck still self-narrates its pacing without audio. The narration
// target is resolved per-deck-language (ttsTarget.ts's resolveNarrationTarget,
// backed by lib/ttsLangRules.ts) and may route to the browser's built-in
// SpeechSynthesis (lib/browserTts.ts) instead of a remote TTS call — that
// path never produces a duration up-front, so its elapsed-time bookkeeping
// reuses the same spentRef/fallbackStartRef accounting as the estimated-time
// fallback below.
//
// Architecture note: playback bookkeeping (the currently loaded narration,
// elapsed/paused timers, the prefetch cache) lives in refs rather than
// state, and is driven by two small effects — one that (re)loads narration
// whenever `currentIndex` changes, one that starts/stops playback whenever
// `isPlaying` toggles — plus a single always-on ticker for the elapsed-time
// display. This split means pausing/resuming never re-synthesizes or
// restarts a slide's narration from zero, and manual prev/next during
// playback naturally continues playing the next slide (no special-casing
// needed) since both effects just react to whichever state changed.
import { Maximize2, Minimize2, Pause, Play, SkipBack, SkipForward, X } from 'lucide-preact'
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { lazy, Suspense } from 'preact/compat'
import type { ComponentType } from 'preact/compat'
import { SlideView } from '../../components/slides/SlideView'
import { t } from '../../i18n'
import { type BrowserSpeechHandle, createBrowserSpeech, isBrowserTtsSupported } from '../../lib/browserTts'
import { loadLlmConfig } from '../../lib/llmConfig'
import { synthesizeSpeech } from '../../lib/tts'
import type { PresentPlayerProps } from '../../types'
import { loadPresenterCharacterSettings } from '../../vrm/characterSettings'
import type { PresenterCharacterProps } from '../../vrm/PresenterCharacter'
import './present.css'
import { resolveNarrationTarget, type ResolvedNarrationTarget } from './ttsTarget'

// Dynamically imported so three.js (PresenterCharacter.tsx + vrm/loader.ts +
// vrm/stage.ts) only ever loads as its own chunk, fetched the first time a
// presenter character is actually enabled — never as part of this feature's
// (or the app's) main bundle. See notes-tc-town.md §4 / the vrm/ dir header
// comments for the vendoring rationale.
const PresenterCharacter = lazy(() => import('../../vrm/PresenterCharacter')) as ComponentType<PresenterCharacterProps>

const FALLBACK_CPS_KEY = 'tc-presenter-present-fallback-cps'
const DEFAULT_FALLBACK_CPS = 14
const MIN_FALLBACK_CPS = 4
const MAX_FALLBACK_CPS = 40
const MIN_DWELL_MS = 1800
const TICK_MS = 200

type NarrationReason = 'empty' | 'no-tts' | 'error'
type NarrationSource =
  | { kind: 'audio'; url: string }
  | { kind: 'browser'; text: string; target: Extract<ResolvedNarrationTarget, { kind: 'browser' }> }
  | { kind: 'fallback'; durationMs: number; reason: NarrationReason }

function loadFallbackCps(): number {
  try {
    const raw = localStorage.getItem(FALLBACK_CPS_KEY)
    const n = raw ? Number(raw) : NaN
    if (Number.isFinite(n) && n >= MIN_FALLBACK_CPS && n <= MAX_FALLBACK_CPS) return n
  } catch {
    // localStorage unavailable — use the default
  }
  return DEFAULT_FALLBACK_CPS
}

function saveFallbackCps(cps: number): void {
  try {
    localStorage.setItem(FALLBACK_CPS_KEY, String(cps))
  } catch {
    // best-effort persistence only
  }
}

function estimateNarrationMs(text: string, cps: number): number {
  const chars = text.trim().length
  if (chars === 0) return MIN_DWELL_MS
  return Math.max(MIN_DWELL_MS, Math.round((chars / Math.max(1, cps)) * 1000))
}

function formatTime(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

async function loadNarration(
  target: ResolvedNarrationTarget | null,
  text: string,
  cps: number,
): Promise<NarrationSource> {
  const trimmed = text.trim()
  if (!trimmed) return { kind: 'fallback', durationMs: estimateNarrationMs(trimmed, cps), reason: 'empty' }
  if (!target) return { kind: 'fallback', durationMs: estimateNarrationMs(trimmed, cps), reason: 'no-tts' }
  if (target.kind === 'browser') {
    if (!isBrowserTtsSupported()) return { kind: 'fallback', durationMs: estimateNarrationMs(trimmed, cps), reason: 'no-tts' }
    return { kind: 'browser', text: trimmed, target }
  }
  try {
    const blob = await synthesizeSpeech({
      connection: target.connection,
      model: target.model,
      voice: target.voice ?? 'alloy',
      text: trimmed,
    })
    return { kind: 'audio', url: URL.createObjectURL(blob) }
  } catch {
    return { kind: 'fallback', durationMs: estimateNarrationMs(trimmed, cps), reason: 'error' }
  }
}

const BASE_WIDTH = 1280

export function PresentPlayer({ deck, onExit, autoPlay = true, presetId }: PresentPlayerProps) {
  const [currentIndex, setCurrentIndex] = useState(0)
  const [isPlaying, setIsPlaying] = useState(autoPlay)
  const [isLoading, setIsLoading] = useState(true)
  const [notice, setNotice] = useState<NarrationReason | null>(null)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [totalMs, setTotalMs] = useState(0)
  const [fallbackCps, setFallbackCps] = useState<number>(() => loadFallbackCps())
  const [scale, setScale] = useState(1)
  const [isFullscreen, setIsFullscreen] = useState(false)

  const containerRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  if (!audioRef.current && typeof Audio !== 'undefined') audioRef.current = new Audio()

  const cacheRef = useRef<Map<number, Promise<NarrationSource>>>(new Map())
  const narrationRef = useRef<NarrationSource | null>(null)
  const objectUrlsRef = useRef<Set<string>>(new Set())
  const browserHandleRef = useRef<BrowserSpeechHandle | null>(null)
  const spentRef = useRef(0)
  const fallbackStartRef = useRef<number | null>(null)
  const fallbackTimerId = useRef<number | null>(null)
  const indexTokenRef = useRef(0)

  const deckRef = useRef(deck)
  useEffect(() => {
    deckRef.current = deck
  }, [deck])
  const currentIndexRef = useRef(currentIndex)
  useEffect(() => {
    currentIndexRef.current = currentIndex
  }, [currentIndex])
  const isPlayingRef = useRef(isPlaying)
  useEffect(() => {
    isPlayingRef.current = isPlaying
  }, [isPlaying])
  const fallbackCpsRef = useRef(fallbackCps)
  useEffect(() => {
    fallbackCpsRef.current = fallbackCps
  }, [fallbackCps])

  // Resolved once at mount — a mounted player's TTS target doesn't change
  // mid-presentation even if Settings is edited in another tab.
  const [ttsTarget] = useState<ResolvedNarrationTarget | null>(() => {
    const config = loadLlmConfig()
    return config ? resolveNarrationTarget(config, deck.lang, presetId) : null
  })

  // Same "resolved once at mount" rationale as ttsTarget above — the
  // presenter-character panel (PresentTab -> vrm/CharacterManager.tsx) only
  // edits this while the player isn't mounted anyway (PresentTab unmounts
  // PresentPlayer to show it), so a live subscription isn't needed.
  const [characterSettings] = useState(() => loadPresenterCharacterSettings())

  const getSlide = useCallback(() => deckRef.current.slides[currentIndexRef.current], [])

  const advance = useCallback(() => {
    setCurrentIndex((idx) => {
      const total = deckRef.current.slides.length
      if (idx + 1 >= total) {
        setIsPlaying(false)
        return idx
      }
      return idx + 1
    })
  }, [])

  const goNext = useCallback(() => {
    setCurrentIndex((idx) => Math.min(deckRef.current.slides.length - 1, idx + 1))
  }, [])
  const goPrev = useCallback(() => {
    setCurrentIndex((idx) => Math.max(0, idx - 1))
  }, [])

  function getNarration(index: number): Promise<NarrationSource> | undefined {
    const slides = deckRef.current.slides
    if (index < 0 || index >= slides.length) return undefined
    const cache = cacheRef.current
    const cached = cache.get(index)
    if (cached) return cached
    const slide = slides[index]
    const promise = loadNarration(ttsTarget, slide.speakerNotes, fallbackCpsRef.current).then((result) => {
      if (result.kind === 'audio') objectUrlsRef.current.add(result.url)
      return result
    })
    cache.set(index, promise)
    return promise
  }

  const fallbackFromError = useCallback((): NarrationSource => {
    const notes = getSlide()?.speakerNotes ?? ''
    const fallback: NarrationSource = {
      kind: 'fallback',
      durationMs: estimateNarrationMs(notes, fallbackCpsRef.current),
      reason: 'error',
    }
    narrationRef.current = fallback
    setNotice('error')
    setTotalMs(fallback.durationMs)
    spentRef.current = 0
    return fallback
  }, [getSlide])

  const applyPlayPause = useCallback(() => {
    const narration = narrationRef.current
    if (!narration) return
    const audio = audioRef.current

    if (!isPlayingRef.current) {
      if (narration.kind === 'audio') {
        audio?.pause()
      } else if (narration.kind === 'browser') {
        browserHandleRef.current?.pause()
        if (fallbackStartRef.current !== null) {
          spentRef.current += Date.now() - fallbackStartRef.current
          fallbackStartRef.current = null
        }
      } else {
        if (fallbackTimerId.current !== null) {
          window.clearTimeout(fallbackTimerId.current)
          fallbackTimerId.current = null
        }
        if (fallbackStartRef.current !== null) {
          spentRef.current += Date.now() - fallbackStartRef.current
          fallbackStartRef.current = null
        }
      }
      return
    }

    if (narration.kind === 'audio') {
      audio?.play().catch(() => {
        fallbackFromError()
        applyPlayPause()
      })
    } else if (narration.kind === 'browser') {
      fallbackStartRef.current = Date.now()
      if (browserHandleRef.current) {
        browserHandleRef.current.resume()
      } else {
        const { target } = narration
        const handle = createBrowserSpeech({
          text: narration.text,
          lang: target.lang,
          voiceURI: target.voiceURI,
          rate: target.rate,
          pitch: target.pitch,
          onEnd: () => {
            browserHandleRef.current = null
            advance()
          },
          onError: () => {
            browserHandleRef.current = null
            fallbackFromError()
            applyPlayPause()
          },
        })
        browserHandleRef.current = handle
        handle.play()
      }
    } else {
      const remaining = Math.max(0, narration.durationMs - spentRef.current)
      fallbackStartRef.current = Date.now()
      fallbackTimerId.current = window.setTimeout(() => {
        fallbackStartRef.current = null
        spentRef.current = narration.durationMs
        advance()
      }, remaining)
    }
  }, [advance, fallbackFromError])

  // Load (or reuse a prefetched) narration whenever the current slide changes.
  useEffect(() => {
    const token = ++indexTokenRef.current
    narrationRef.current = null
    setIsLoading(true)
    setNotice(null)
    setTotalMs(0)
    setElapsedMs(0)
    spentRef.current = 0
    fallbackStartRef.current = null
    if (fallbackTimerId.current !== null) {
      window.clearTimeout(fallbackTimerId.current)
      fallbackTimerId.current = null
    }
    browserHandleRef.current?.stop()
    browserHandleRef.current = null
    const audio = audioRef.current
    if (audio) {
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
    }

    const promise = getNarration(currentIndex)
    if (!promise) return

    promise.then((result) => {
      if (indexTokenRef.current !== token) return // superseded by a newer slide change
      narrationRef.current = result
      setIsLoading(false)
      if (result.kind === 'audio') {
        if (audio) audio.src = result.url
      } else if (result.kind === 'browser') {
        // Duration is unknown up-front for browser SpeechSynthesis — totalMs
        // stays 0, which the time readout renders as '--:--'.
      } else {
        setTotalMs(result.durationMs)
        if (result.reason !== 'empty') setNotice(result.reason)
      }
      getNarration(currentIndex + 1) // prefetch, fire-and-forget
      applyPlayPause()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIndex, deck])

  // Pure play/pause toggle — never re-fetches narration.
  useEffect(() => {
    applyPlayPause()
  }, [isPlaying, applyPlayPause])

  // Invalidate not-yet-fetched prefetches when the fallback speed changes
  // (the currently playing/loaded slide keeps its already-resolved value).
  useEffect(() => {
    const cache = cacheRef.current
    const kept = new Map<number, Promise<NarrationSource>>()
    const current = cache.get(currentIndex)
    if (current) kept.set(currentIndex, current)
    cacheRef.current = kept
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fallbackCps])

  // Elapsed-time ticker for the progress readout — only runs while playing;
  // reads through refs so it stays correct across slide changes without
  // needing to be re-created for that reason too.
  useEffect(() => {
    if (!isPlaying) return
    const iv = window.setInterval(() => {
      const narration = narrationRef.current
      if (!narration) return
      if (narration.kind === 'audio') {
        const audio = audioRef.current
        if (audio) setElapsedMs(audio.currentTime * 1000)
      } else {
        const spent = spentRef.current + (fallbackStartRef.current !== null ? Date.now() - fallbackStartRef.current : 0)
        setElapsedMs(spent)
      }
    }, TICK_MS)
    return () => window.clearInterval(iv)
  }, [isPlaying])

  // Audio element listeners — attached once, always read the latest state via refs/callbacks.
  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    const handleEnded = () => advance()
    const handleError = () => {
      fallbackFromError()
      if (isPlayingRef.current) applyPlayPause()
    }
    const handleLoadedMetadata = () => {
      if (Number.isFinite(audio.duration)) setTotalMs(audio.duration * 1000)
    }
    audio.addEventListener('ended', handleEnded)
    audio.addEventListener('error', handleError)
    audio.addEventListener('loadedmetadata', handleLoadedMetadata)
    return () => {
      audio.removeEventListener('ended', handleEnded)
      audio.removeEventListener('error', handleError)
      audio.removeEventListener('loadedmetadata', handleLoadedMetadata)
    }
  }, [advance, applyPlayPause, fallbackFromError])

  // Unmount cleanup: stop audio/timers/browser speech, release every synthesized blob URL.
  useEffect(() => {
    return () => {
      audioRef.current?.pause()
      browserHandleRef.current?.stop()
      browserHandleRef.current = null
      if (fallbackTimerId.current !== null) window.clearTimeout(fallbackTimerId.current)
      for (const url of objectUrlsRef.current) URL.revokeObjectURL(url)
    }
  }, [])

  // Fit the fixed-size slide canvas into the available stage area.
  const baseHeight = deck.theme.aspectRatio === '4:3' ? Math.round((BASE_WIDTH * 3) / 4) : Math.round((BASE_WIDTH * 9) / 16)
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const compute = () => {
      const rect = el.getBoundingClientRect()
      const s = Math.min(rect.width / BASE_WIDTH, rect.height / baseHeight)
      setScale(s > 0 && Number.isFinite(s) ? s : 1)
    }
    compute()
    const ro = new ResizeObserver(compute)
    ro.observe(el)
    return () => ro.disconnect()
  }, [baseHeight])

  // Best-effort fullscreen — some browsers require the request to originate
  // from a direct user gesture; opening the Present tab is one, but if it's
  // denied the manual toggle button below still works.
  useEffect(() => {
    const el = containerRef.current
    el?.requestFullscreen?.().catch(() => {})
    return () => {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
    }
  }, [])
  useEffect(() => {
    function onChange() {
      setIsFullscreen(document.fullscreenElement === containerRef.current)
    }
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])
  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
    else containerRef.current?.requestFullscreen?.().catch(() => {})
  }, [])

  // Keyboard: space=play/pause, arrows=prev/next, Esc=exit.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (e.key === ' ') {
        e.preventDefault()
        setIsPlaying((p) => !p)
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        goNext()
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        goPrev()
      } else if (e.key === 'Escape') {
        onExit()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [goNext, goPrev, onExit])

  const handleFallbackCpsChange = useCallback((value: number) => {
    if (!Number.isFinite(value)) return
    const clamped = Math.min(MAX_FALLBACK_CPS, Math.max(MIN_FALLBACK_CPS, Math.round(value)))
    setFallbackCps(clamped)
    saveFallbackCps(clamped)
  }, [])

  const slide = deck.slides[currentIndex]
  const buildStageTotal = useMemo(() => {
    if (!slide?.buildStage.isBuildSlide || !slide.buildStage.groupId) return undefined
    const groupId = slide.buildStage.groupId
    return deck.slides.filter((s) => s.buildStage.groupId === groupId).length
  }, [slide, deck.slides])

  const noticeText =
    notice === 'error' ? t('present.ttsError') : notice === 'no-tts' ? t('present.ttsUnavailable') : null

  // Lip-sync drive signal: true whenever narration (real TTS audio or the
  // estimated-reading-time fallback timer) is actively advancing, i.e. the
  // same condition under which applyPlayPause() is actually running a timer
  // or a playing <audio>. Loading/paused/between-slides all read as false.
  const speaking = isPlaying && !isLoading

  if (deck.slides.length === 0 || !slide) {
    return (
      <div class="present-stage" ref={containerRef}>
        <div class="present-empty">
          <p>{t('present.emptyTitle')}</p>
          <button type="button" onClick={onExit}>
            {t('present.exit')}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div class="present-stage" ref={containerRef}>
      <div class="present-stage__slide" ref={stageRef}>
        <SlideView slide={slide} theme={deck.theme} scale={scale} pageTotal={deck.slides.length} buildStageTotal={buildStageTotal} />
        {isLoading && <div class="present-loading" aria-hidden="true" />}
        {characterSettings.enabled && characterSettings.selected && (
          <div
            class={`present-character present-character--${characterSettings.position} present-character--${characterSettings.size}`}
          >
            <Suspense fallback={null}>
              <PresenterCharacter vrmRef={characterSettings.selected} speaking={speaking} framing="upper" />
            </Suspense>
          </div>
        )}
      </div>

      {noticeText && <div class="present-notice">{noticeText}</div>}

      <div class="present-controls">
        <button
          type="button"
          class="present-controls__btn"
          onClick={goPrev}
          disabled={currentIndex === 0}
          aria-label={t('present.prev')}
        >
          <SkipBack size={20} />
        </button>
        <button
          type="button"
          class="present-controls__btn present-controls__btn--main"
          onClick={() => setIsPlaying((p) => !p)}
          aria-label={isPlaying ? t('present.pause') : t('present.play')}
        >
          {isPlaying ? <Pause size={22} /> : <Play size={22} />}
        </button>
        <button
          type="button"
          class="present-controls__btn"
          onClick={goNext}
          disabled={currentIndex === deck.slides.length - 1}
          aria-label={t('present.next')}
        >
          <SkipForward size={20} />
        </button>

        <input
          type="range"
          class="present-controls__progress"
          min={0}
          max={deck.slides.length - 1}
          step={1}
          value={currentIndex}
          onInput={(e) => setCurrentIndex(Number((e.target as HTMLInputElement).value))}
          aria-label={t('present.slideOf', { current: currentIndex + 1, total: deck.slides.length })}
        />

        <span class="present-controls__time">
          {formatTime(elapsedMs)} / {totalMs > 0 ? formatTime(totalMs) : '--:--'}
        </span>
        <span class="present-controls__count">
          {t('present.slideOf', { current: currentIndex + 1, total: deck.slides.length })}
        </span>

        <label class="present-controls__speed" title={t('present.fallbackSpeedHint')}>
          {t('present.fallbackSpeedLabel')}
          <input
            type="number"
            min={MIN_FALLBACK_CPS}
            max={MAX_FALLBACK_CPS}
            value={fallbackCps}
            onInput={(e) => handleFallbackCpsChange(Number((e.target as HTMLInputElement).value))}
          />
        </label>

        <button
          type="button"
          class="present-controls__btn"
          onClick={toggleFullscreen}
          aria-label={t('present.fullscreenToggle')}
        >
          {isFullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
        </button>
        <button type="button" class="present-controls__btn present-controls__exit" onClick={onExit}>
          <X size={18} />
          {t('present.exit')}
        </button>
      </div>
    </div>
  )
}

export default PresentPlayer

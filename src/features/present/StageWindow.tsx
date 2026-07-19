// The audience/projector side of the two-window Present split (see
// stageSync.ts's header comment for the full design). This window renders
// nothing but the current slide full-bleed: no controls, no editing, no
// TTS playback (that stays in the presenter window, same machine/speakers).
// It is a dumb renderer driven entirely by StageState snapshots received
// over createStageEndpoint — it holds no presentation state of its own
// beyond "what was the last message".
//
// Three states, matching the stageSync.ts protocol 1:1:
//   - waiting: no snapshot received yet (just opened, or presenter hasn't
//     sent one — the `hello` handshake is what triggers the first one)
//   - live: rendering the last received StageState
//   - ended: the presenter sent `end` (closed the tab, exited Present).
//     A later `state` message (presenter reopened/resumed) moves back to
//     live — same as PresentPlayer's own re-render behavior, just driven
//     by messages instead of local state changes.
// While live, the stage also mirrors the presenter's Q&A slide-overview
// grid: when StageState.gridVisible is true, SlideGridOverlay is rendered
// read-only (no onSelect) as an overlay on top of the slide.
import { Maximize2, Minimize2 } from 'lucide-preact'
import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import { lazy, Suspense } from 'preact/compat'
import type { ComponentType } from 'preact/compat'
import { SlideView } from '../../components/slides/SlideView'
import { SlideGridOverlay } from './SlideGridOverlay'
import { t } from '../../i18n'
import { createStageEndpoint, type StageState } from './stageSync'
import { loadPresenterCharacterSettings, type PresenterCharacterSettings } from '../../vrm/characterSettings'
import type { PresenterCharacterProps } from '../../vrm/PresenterCharacter'
import './stage-window.css'

// Same rationale as PresentPlayer.tsx: keep three.js out of this window's
// main bundle, only fetched if a presenter character is actually enabled.
const PresenterCharacter = lazy(() => import('../../vrm/PresenterCharacter')) as ComponentType<PresenterCharacterProps>

const BASE_WIDTH = 1280
const TOOLBAR_HIDE_MS = 2500

type StagePhase = 'waiting' | 'live' | 'ended'

export function StageWindow() {
  const [phase, setPhase] = useState<StagePhase>('waiting')
  const [state, setState] = useState<StageState | null>(null)
  const [scale, setScale] = useState(1)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [toolbarVisible, setToolbarVisible] = useState(true)

  // Resolved once at mount — mirrors PresentPlayer.tsx: localStorage is
  // shared same-origin, so the stage reads it directly instead of the
  // presenter pushing it over the channel (only the live `speaking` signal
  // needs syncing; see stageSync.ts's header comment).
  const [characterSettings] = useState<PresenterCharacterSettings>(() => loadPresenterCharacterSettings())

  const containerRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const toolbarTimerRef = useRef<number | null>(null)

  useEffect(() => {
    const endpoint = createStageEndpoint({
      onState: (next) => {
        setState(next)
        setPhase('live')
        document.title = next.deck.title
      },
      onEnd: () => setPhase('ended'),
    })
    return () => endpoint.close()
  }, [])

  const deck = state?.deck
  const slide = deck?.slides[state?.currentIndex ?? 0]
  const baseHeight = deck?.theme.aspectRatio === '4:3' ? Math.round((BASE_WIDTH * 3) / 4) : Math.round((BASE_WIDTH * 9) / 16)

  // Fit the fixed-size slide canvas into the available viewport — same
  // approach as PresentPlayer.tsx (lines ~405-419): observe the stage
  // container and scale to the tighter of width/height ratios.
  useEffect(() => {
    const el = stageRef.current
    if (!el || phase !== 'live') return
    const compute = () => {
      const rect = el.getBoundingClientRect()
      const s = Math.min(rect.width / BASE_WIDTH, rect.height / baseHeight)
      setScale(s > 0 && Number.isFinite(s) ? s : 1)
    }
    compute()
    const ro = new ResizeObserver(compute)
    ro.observe(el)
    return () => ro.disconnect()
  }, [phase, baseHeight])

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

  // Toolbar auto-hide: any mouse movement reveals it, then it fades out
  // after a few seconds of stillness — kept minimal since the stage has no
  // other controls to compete for attention with the slide.
  const revealToolbar = useCallback(() => {
    setToolbarVisible(true)
    if (toolbarTimerRef.current !== null) window.clearTimeout(toolbarTimerRef.current)
    toolbarTimerRef.current = window.setTimeout(() => setToolbarVisible(false), TOOLBAR_HIDE_MS)
  }, [])

  useEffect(() => {
    revealToolbar()
    return () => {
      if (toolbarTimerRef.current !== null) window.clearTimeout(toolbarTimerRef.current)
    }
  }, [revealToolbar])

  return (
    <div class="stage-window" ref={containerRef} onMouseMove={revealToolbar}>
      {phase === 'waiting' && (
        <div class="stage-window__message">
          <p>{t('present.stageWaiting')}</p>
        </div>
      )}

      {phase === 'ended' && (
        <div class="stage-window__message">
          <p>{t('present.ended')}</p>
        </div>
      )}

      {phase === 'live' && deck && slide && state && (
        <>
          <div class="stage-window__slide" ref={stageRef} onDblClick={toggleFullscreen}>
            <SlideView
              slide={slide}
              theme={deck.theme}
              scale={scale}
              pageTotal={deck.slides.length}
              buildStageTotal={state.buildStageTotal}
            />
            {characterSettings.enabled && characterSettings.selected && (
              <div
                class={`stage-window__character stage-window__character--${characterSettings.position} stage-window__character--${characterSettings.size}`}
              >
                <Suspense fallback={null}>
                  <PresenterCharacter vrmRef={characterSettings.selected} speaking={state.speaking} framing="upper" />
                </Suspense>
              </div>
            )}
            {state.showCaptions && slide.speakerNotes.trim() && (
              <div class="stage-window__captions">
                <div class="stage-window__captions-primary">{slide.speakerNotes.trim()}</div>
                {state.captionTranslation && (
                  <div class="stage-window__captions-secondary">{state.captionTranslation}</div>
                )}
              </div>
            )}
          </div>
          {state.gridVisible && <SlideGridOverlay deck={deck} currentIndex={state.currentIndex} />}
        </>
      )}

      <button
        type="button"
        class={`stage-window__fullscreen-btn${toolbarVisible ? ' stage-window__fullscreen-btn--visible' : ''}`}
        onClick={toggleFullscreen}
        aria-label={t('present.fullscreenToggle')}
        title={t('present.fullscreenToggle')}
      >
        {isFullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
      </button>
    </div>
  )
}

export default StageWindow

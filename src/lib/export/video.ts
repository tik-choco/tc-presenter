// Deck -> narrated slideshow video export. Renders each slide with the same
// offscreen pipeline PDF/PPTX export use (lib/evaluator/visionRender), draws
// it into an offscreen <canvas>, and — where narration audio is available —
// synthesizes it through the same TTS target PresentPlayer resolves
// (features/present/ttsTarget.ts), mixing it into the canvas's captured
// video stream via the Web Audio API. Everything is recorded with
// MediaRecorder; no extra dependency is added (browser APIs only).
//
// Browser SpeechSynthesis (ttsTarget's `kind: 'browser'`) has no API to
// capture its audio output as a MediaStream, so it cannot be recorded here —
// decks whose narration target resolves to 'browser' (or has no TTS
// configured at all) fall back to silent, reading-time-estimated slide
// durations, same as PresentPlayer does when TTS is unavailable.
//
// Timing: every slide, narrated or silent, is driven by one
// AudioBufferSourceNode's `ended` event rather than a `setInterval`/
// `requestAnimationFrame` loop. Background/inactive tabs throttle ordinary
// timers, which would desync a timer-driven "advance to next slide" from
// audio that keeps playing on the (unthrottled) Web Audio rendering thread;
// chaining off `ended` instead means the recording's actual advancement is
// always driven by the same clock the recorded audio plays on, silent
// slides included (they get a zero-filled buffer of the estimated
// duration, scheduled the same way).
import { renderSlideToPng } from '../evaluator/visionRender'
import { resolveNarrationTarget, type ResolvedNarrationTarget } from '../../features/present/ttsTarget'
import { loadLlmConfig } from '../llmConfig'
import { synthesizeSpeech } from '../tts'
import type { Deck, DeckTheme, Slide } from '../../types'
import { sanitizeFilename } from './filename'

const WIDTH = 1280
const FRAME_RATE = 30

/** Reading-time fallback for slides with no usable narration audio —
 * deliberately a different (tighter) range than PresentPlayer's live-preview
 * fallback (MIN_DWELL_MS=1800, no cap): a recorded video is watched start to
 * finish rather than skipped through, so very long silent dwells are capped. */
const FALLBACK_MIN_MS = 3000
const FALLBACK_MAX_MS = 15000
const FALLBACK_CPS = 14

/** Silence padded before/after each narrated slide's audio so the voice
 * doesn't start exactly on the slide's first visible frame or cut off right
 * as the next slide appears. */
const LEAD_MS = 200
const TRAIL_MS = 200

const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm',
]

function pickMimeType(): string | null {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return null
  for (const candidate of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(candidate)) return candidate
  }
  return null
}

function estimateFallbackMs(text: string): number {
  const chars = text.trim().length
  if (chars === 0) return FALLBACK_MIN_MS
  const ms = Math.round((chars / FALLBACK_CPS) * 1000)
  return Math.min(FALLBACK_MAX_MS, Math.max(FALLBACK_MIN_MS, ms))
}

function loadImage(dataUri: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Failed to decode rendered slide image'))
    img.src = dataUri
  })
}

/** Builds the single AudioBuffer that will be scheduled for one slide: the
 * decoded narration (if any) padded with lead/trail silence, or — with no
 * narration — a plain silent buffer sized to the estimated reading time. */
function buildSegmentBuffer(ctx: AudioContext, narration: AudioBuffer | null, fallbackMs: number): AudioBuffer {
  const sampleRate = ctx.sampleRate
  if (!narration) {
    const frames = Math.max(1, Math.ceil((fallbackMs / 1000) * sampleRate))
    return ctx.createBuffer(1, frames, sampleRate)
  }
  const leadFrames = Math.round((LEAD_MS / 1000) * sampleRate)
  const trailFrames = Math.round((TRAIL_MS / 1000) * sampleRate)
  const totalFrames = leadFrames + narration.length + trailFrames
  const out = ctx.createBuffer(narration.numberOfChannels, totalFrames, sampleRate)
  for (let ch = 0; ch < narration.numberOfChannels; ch++) {
    out.getChannelData(ch).set(narration.getChannelData(ch), leadFrames)
  }
  return out
}

interface SlideAssets {
  image: HTMLImageElement
  segment: AudioBuffer
}

/** Synthesizes (when possible) and decodes one slide's narration, falling
 * back to null on an unconfigured/unsupported/failed target — mirrors
 * PresentPlayer's loadNarration reason handling, minus the UI-facing notice. */
async function synthesizeSlideAudio(
  ctx: AudioContext,
  target: ResolvedNarrationTarget | null,
  text: string,
): Promise<AudioBuffer | null> {
  const trimmed = text.trim()
  if (!trimmed || !target || target.kind !== 'remote') return null
  try {
    const blob = await synthesizeSpeech({
      connection: target.connection,
      model: target.model,
      voice: target.voice ?? 'alloy',
      text: trimmed,
    })
    const arrayBuffer = await blob.arrayBuffer()
    return await ctx.decodeAudioData(arrayBuffer)
  } catch {
    return null
  }
}

async function prepareSlide(ctx: AudioContext, target: ResolvedNarrationTarget | null, slide: Slide, theme: DeckTheme, total: number): Promise<SlideAssets> {
  const [png, narration] = await Promise.all([
    renderSlideToPng(slide, theme, total, 1),
    synthesizeSlideAudio(ctx, target, slide.speakerNotes),
  ])
  if (!png) throw new Error(`Failed to rasterize slide ${slide.index}`)
  const image = await loadImage(png)
  const segment = buildSegmentBuffer(ctx, narration, estimateFallbackMs(slide.speakerNotes))
  return { image, segment }
}

/** Plays one slide's audio segment to completion, or rejects with an
 * AbortError as soon as `signal` fires. The recording runs in real time (a
 * segment can be several seconds), so — unlike the slide loop's
 * per-iteration checks below — cancellation here can't wait for the next
 * loop tick; it needs to stop the in-flight source immediately so the
 * recorded output actually ends where the user asked it to. `once: true`
 * means the abort listener self-removes once fired; the `onended` path
 * mirrors that by removing it manually so a normal (non-aborted) segment end
 * doesn't leave a dangling listener on `signal` for the rest of the export. */
function playSegment(
  ctx: AudioContext,
  destination: MediaStreamAudioDestinationNode,
  buffer: AudioBuffer,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(destination)

    const onAbort = (): void => {
      try {
        source.stop()
      } catch {
        // already stopped/ended
      }
      reject(new DOMException('Aborted', 'AbortError'))
    }

    source.onended = () => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    source.start()
  })
}

function stopTracks(stream: MediaStream | null | undefined): void {
  stream?.getTracks().forEach((track) => track.stop())
}

/**
 * Renders `deck` to a narrated slideshow video and triggers a browser
 * download. `onProgress(current, total)` fires once per slide, when
 * recording enters that slide's segment (1-based) — real-time, since the
 * recording takes as long as the narrated deck's total runtime.
 *
 * `signal`, when aborted, stops the export by throwing a DOMException named
 * 'AbortError' — exportJobs.ts's runJob recognizes that name and settles the
 * job as `cancelled` rather than `failed`. Because a segment can play for
 * several real-time seconds, a per-slide-boundary check alone would leave
 * cancellation feeling unresponsive, so `playSegment` also watches `signal`
 * directly and stops the in-flight audio source immediately. Either way,
 * the throw happens before the download's `a.click()` below — the `finally`
 * block still runs and tears down the recorder/tracks/AudioContext.
 */
export async function exportDeckToVideo(
  deck: Deck,
  onProgress?: (current: number, total: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (typeof document === 'undefined') throw new Error('Video export requires a browser environment.')
  if (typeof HTMLCanvasElement === 'undefined' || typeof HTMLCanvasElement.prototype.captureStream !== 'function') {
    throw new Error('This browser does not support canvas.captureStream — video export is unavailable.')
  }
  const mimeType = pickMimeType()
  if (!mimeType) throw new Error('This browser has no supported MediaRecorder video format.')

  const total = deck.slides.length
  if (total === 0) throw new Error('Deck has no slides to export.')

  const width = WIDTH
  const height = deck.theme.aspectRatio === '4:3' ? Math.round((WIDTH * 3) / 4) : Math.round((WIDTH * 9) / 16)

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const canvasCtx = canvas.getContext('2d')
  if (!canvasCtx) throw new Error('Failed to acquire a 2D canvas context.')

  const AudioContextCtor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioContextCtor) throw new Error('This browser does not support the Web Audio API.')
  const audioCtx = new AudioContextCtor()

  let videoStream: MediaStream | null = null
  let combinedStream: MediaStream | null = null
  let objectUrl: string | null = null
  let recorder: MediaRecorder | null = null
  let redrawTimer: ReturnType<typeof window.setInterval> | null = null

  try {
    await audioCtx.resume().catch(() => undefined)
    const destination = audioCtx.createMediaStreamDestination()

    const config = loadLlmConfig()
    const target = config ? resolveNarrationTarget(config, deck.lang) : null

    videoStream = canvas.captureStream(FRAME_RATE)
    combinedStream = new MediaStream([...videoStream.getVideoTracks(), ...destination.stream.getAudioTracks()])

    recorder = new MediaRecorder(combinedStream, { mimeType })
    const chunks: BlobPart[] = []
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data)
    }

    const stopped = new Promise<void>((resolve, reject) => {
      recorder!.onstop = () => resolve()
      recorder!.onerror = (e) => reject(e.error ?? new Error(e.message || 'MediaRecorder error'))
    })

    let nextAssets = await prepareSlide(audioCtx, target, deck.slides[0], deck.theme, total)
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    recorder.start()

    // canvas.captureStream() only pushes a new frame to the stream when the
    // canvas is actually repainted — it does NOT sample the canvas at
    // FRAME_RATE on its own. The loop below only calls drawImage() once per
    // slide (on slide change), so without this timer the recorded stream
    // would carry at most one video frame per slide — some MediaRecorder
    // implementations then encode a video track with essentially no visible
    // motion/duration, producing a file that's audio-only in practice. A
    // low-frequency repaint of whatever slide is currently on screen keeps a
    // steady stream of frames flowing for the whole segment. 200ms (~5fps)
    // is plenty for a static slide — nothing here animates within a
    // segment — and if the tab is backgrounded, browsers throttle
    // setInterval to ~1Hz, which is still enough motion to keep a static
    // slide "alive" for the recording (same reasoning PresentPlayer's timer
    // doc above already applies to this file's `ended`-driven audio clock;
    // this is the analogous allowance for the redraw side).
    let currentImage: HTMLImageElement | null = null
    redrawTimer = window.setInterval(() => {
      if (currentImage) canvasCtx.drawImage(currentImage, 0, 0, width, height)
    }, 200)

    for (let i = 0; i < total; i++) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      onProgress?.(i + 1, total)
      const assets = nextAssets
      currentImage = assets.image
      canvasCtx.drawImage(assets.image, 0, 0, width, height)

      const prefetch = i + 1 < total ? prepareSlide(audioCtx, target, deck.slides[i + 1], deck.theme, total) : null
      // Guard against an unhandled rejection: if playSegment below throws
      // because `signal` aborted mid-segment, this function unwinds before
      // ever awaiting `prefetch` — if the prefetch (a TTS fetch + decode)
      // later rejects on its own with nothing left to observe it, that
      // would otherwise surface as an unhandledrejection.
      void prefetch?.catch(() => {})
      await playSegment(audioCtx, destination, assets.segment, signal)
      if (prefetch) nextAssets = await prefetch
    }

    recorder.stop()
    await stopped

    const blob = new Blob(chunks, { type: mimeType })
    const ext = mimeType.startsWith('video/mp4') ? 'mp4' : 'webm'
    objectUrl = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = objectUrl
    a.download = `${sanitizeFilename(deck.title)}.${ext}`
    document.body.appendChild(a)
    a.click()
    a.remove()
    // Revoked on a delay, not immediately: the browser reads the blob URL
    // to start the download asynchronously after click(), so revoking in
    // the same tick can race it on some browsers.
    const urlToRevoke = objectUrl
    objectUrl = null
    window.setTimeout(() => URL.revokeObjectURL(urlToRevoke), 30_000)
  } finally {
    if (redrawTimer !== null) window.clearInterval(redrawTimer)
    if (recorder && recorder.state !== 'inactive') {
      try {
        recorder.stop()
      } catch {
        // already stopping/stopped
      }
    }
    stopTracks(videoStream)
    stopTracks(combinedStream)
    await audioCtx.close().catch(() => undefined)
    if (objectUrl) URL.revokeObjectURL(objectUrl)
  }
}

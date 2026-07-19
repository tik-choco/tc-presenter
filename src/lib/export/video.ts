// Deck -> narrated slideshow video export. Renders each slide with the same
// offscreen pipeline PDF/PPTX export use (lib/evaluator/visionRender), draws
// it into an offscreen <canvas>, and — where narration audio is available —
// synthesizes it through the same TTS target PresentPlayer resolves
// (features/present/ttsTarget.ts).
//
// Primary path: offline WebCodecs encoding via mediabunny (`Output` +
// `Mp4OutputFormat` + `CanvasSource`/`AudioBufferSource`, all backed by a
// `BufferTarget`). This used to be a real-time `canvas.captureStream()` +
// `MediaRecorder` recording, which turned out to produce broken files in
// practice: MediaRecorder's streaming output formats don't write a `moov`
// box with the file's total duration or a seek index up front (some
// implementations never write one at all, others only once recording
// stops, by which point the container is effectively append-only) — so
// exported videos opened to a black frame in a lot of players, and seeking
// anywhere in the timeline would jump straight to the end. Labeling the
// blob `video/mp4` didn't help either, since MediaRecorder's actual
// codec/container combinations aren't reliably decodable by OS-native
// players even when `MediaRecorder.isTypeSupported` claims support.
// mediabunny writes a real, finalized MP4 (`fastStart: 'in-memory'` keeps
// `moov` at the front and the duration/seek metadata correct) directly from
// WebCodecs-encoded frames and samples, with no MediaStream or real-time
// wall-clock recording involved — encoding runs as fast as the browser's
// encoder and this loop can go, not at 1x deck playback speed.
//
// Fallback path: browsers without WebCodecs (or without an encodable H.264
// track) fall back to the original `canvas.captureStream()` +
// `MediaRecorder` real-time recording (`exportViaMediaRecorder`), which
// still carries the limitations above (streaming container, no guaranteed
// `moov`/duration, `.webm` unless the browser happens to support recording
// `video/mp4` directly) — it exists purely so those browsers can still
// produce *something* rather than nothing.
//
// Browser SpeechSynthesis (ttsTarget's `kind: 'browser'`) has no API to
// capture its audio output as decodable PCM data, so it cannot be recorded
// by either path — decks whose narration target resolves to 'browser' (or
// has no TTS configured at all) fall back to silent, reading-time-estimated
// slide durations, same as PresentPlayer does when TTS is unavailable.
//
// Captions: burned into the canvas (not a soft/text track — neither export
// path's container carries a subtitle stream here) using the same prefs
// PresentPlayer's on-screen caption overlay reads (features/settings/
// localPrefs: loadCaptionsEnabled/loadCaptionTranslationLang), so a video
// export shows exactly the two-line (original + translated) caption a live
// playback session would. Translation goes through captionTranslation's
// persistent cache — a slide already viewed (and thus translated) during
// live playback exports instantly; anything uncached is translated here at
// export time. Translation failures are non-fatal: prepareCaptions falls
// back to no secondary line rather than aborting the export, since a
// missing translation is far less disruptive than a failed video. The one
// exception is an aborted `signal` — that AbortError is deliberately left
// to propagate so the shared cancellation contract (DOMException
// 'AbortError' -> exportJobs treats the job as cancelled, not failed) still
// works when the user cancels mid-translation.
import {
  Output,
  Mp4OutputFormat,
  BufferTarget,
  CanvasSource,
  AudioBufferSource,
  getFirstEncodableVideoCodec,
  getFirstEncodableAudioCodec,
  type VideoCodec,
  type AudioCodec,
} from 'mediabunny'
import { renderSlideToPng } from '../evaluator/visionRender'
import { resolveNarrationTarget, type ResolvedNarrationTarget } from '../../features/present/ttsTarget'
import { loadLlmConfig } from '../llmConfig'
import { synthesizeSpeech } from '../tts'
import { translateCaption } from '../captionTranslation'
import { loadCaptionsEnabled, loadCaptionTranslationLang } from '../../features/settings/localPrefs'
import type { Deck, Slide } from '../../types'
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

/** mediabunny/WebCodecs primary-path tuning. The deck is nothing but static
 * slide images, so there's no need for a high bitrate or a high frame rate —
 * but a single multi-second-long video frame per slide would make seeking
 * within a slide coarse/unreliable in some players, so each slide's segment
 * is chopped into MB_FRAME_STEP_SEC-long frames (all sampling the same
 * unchanged canvas content) instead of one long one. */
const MB_VIDEO_BITRATE = 2_500_000
const MB_AUDIO_BITRATE = 128_000
const MB_AUDIO_SAMPLE_RATE = 48_000
const MB_FRAME_STEP_SEC = 0.5

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

/** Normalizes a (possibly mono or multi-channel) AudioBuffer to stereo by
 * averaging all channels sample-by-sample and writing the result to both
 * L and R. mediabunny's `AudioBufferSource` is fed a single consistent
 * channel layout for the whole export (see exportViaMediaBunny), so every
 * segment — whatever channel count the decoded narration happened to come
 * back with — is normalized before being added, which keeps the WebCodecs
 * AudioEncoder from choking on a channel-count change mid-stream. Stereo
 * (not mono) is the normalization target because some player/receiver
 * combinations map a mono track to the left speaker only instead of
 * center-panning it — duplicating the mix into both channels is what
 * reliably plays "in the middle" everywhere. No-ops (returns the same
 * buffer) when it's already stereo. */
function normalizeToStereo(buffer: AudioBuffer, ctx: AudioContext): AudioBuffer {
  if (buffer.numberOfChannels === 2) return buffer
  const stereo = ctx.createBuffer(2, buffer.length, buffer.sampleRate)
  const left = stereo.getChannelData(0)
  const channels: Float32Array[] = []
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) channels.push(buffer.getChannelData(ch))
  if (channels.length === 1) {
    left.set(channels[0])
  } else {
    for (let i = 0; i < buffer.length; i++) {
      let sum = 0
      for (let ch = 0; ch < channels.length; ch++) sum += channels[ch][i]
      left[i] = sum / channels.length
    }
  }
  stereo.getChannelData(1).set(left)
  return stereo
}

/** Burned-in caption text for one slide: `primary` is the deck's own
 * language (speakerNotes verbatim), `secondary` is its translation into the
 * viewer's chosen caption language. Either (or both) may be null — no
 * speakerNotes, captions turned off, translation not requested, or
 * translation failed. */
interface SlideCaptions {
  primary: string | null
  secondary: string | null
}

interface SlideAssets {
  image: HTMLImageElement
  segment: AudioBuffer
  captions: SlideCaptions
}

const CAPTION_MAX_WIDTH_RATIO = 0.85
const CAPTION_BOTTOM_MARGIN_RATIO = 0.03
const CAPTION_LINE_HEIGHT = 1.35

/** Word-wraps `text` to fit within `maxWidth` under the canvas context's
 * currently-set font, using `ctx.measureText`. Splits on whitespace first;
 * dense scripts with no whitespace at all (Japanese/Chinese/Korean can pack
 * an entire sentence into a single "word" by that definition) would
 * otherwise overflow the caption box as one unbroken line, so any token
 * that alone still exceeds `maxWidth` falls back to per-character
 * wrapping. */
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = []
  const words = text.split(/\s+/).filter(Boolean)
  let line = ''
  for (const word of words) {
    if (ctx.measureText(word).width > maxWidth) {
      if (line) {
        lines.push(line)
        line = ''
      }
      let chunk = ''
      for (const ch of word) {
        const candidate = chunk + ch
        if (chunk && ctx.measureText(candidate).width > maxWidth) {
          lines.push(chunk)
          chunk = ch
        } else {
          chunk = candidate
        }
      }
      line = chunk
      continue
    }
    const candidate = line ? `${line} ${word}` : word
    if (line && ctx.measureText(candidate).width > maxWidth) {
      lines.push(line)
      line = word
    } else {
      line = candidate
    }
  }
  if (line) lines.push(line)
  return lines
}

function fillRoundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, radius: number): void {
  const r = Math.min(radius, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.arcTo(x + w, y, x + w, y + r, r)
  ctx.lineTo(x + w, y + h - r)
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r)
  ctx.lineTo(x + r, y + h)
  ctx.arcTo(x, y + h, x, y + h - r, r)
  ctx.lineTo(x, y + r)
  ctx.arcTo(x, y, x + r, y, r)
  ctx.closePath()
  ctx.fill()
}

/** Draws the current slide's captions (if any) bottom-center over the
 * already-painted slide image: `primary` (the deck's own language) in
 * larger bold white text, `secondary` (its translation) smaller and dimmer
 * directly beneath it — mirroring PresentPlayer's live two-line caption
 * overlay. A single semi-transparent rounded panel sized to the wrapped
 * text sits behind both lines so captions stay legible over any slide
 * background. No-ops entirely when both lines are null (captions off, no
 * speakerNotes, or no translation available). */
function drawCaptions(ctx: CanvasRenderingContext2D, width: number, height: number, captions: SlideCaptions | null, fontFamily: string): void {
  if (!captions || (!captions.primary && !captions.secondary)) return

  const maxWidth = width * CAPTION_MAX_WIDTH_RATIO
  const primarySize = Math.round(height * 0.042)
  const secondarySize = Math.round(primarySize * 0.8)
  const primaryLineH = primarySize * CAPTION_LINE_HEIGHT
  const secondaryLineH = secondarySize * CAPTION_LINE_HEIGHT

  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'center'

  const primaryFont = `bold ${primarySize}px ${fontFamily}`
  const secondaryFont = `${secondarySize}px ${fontFamily}`

  ctx.font = primaryFont
  const primaryLines = captions.primary ? wrapText(ctx, captions.primary, maxWidth) : []
  ctx.font = secondaryFont
  const secondaryLines = captions.secondary ? wrapText(ctx, captions.secondary, maxWidth) : []
  if (primaryLines.length === 0 && secondaryLines.length === 0) return

  let maxLineWidth = 0
  ctx.font = primaryFont
  for (const l of primaryLines) maxLineWidth = Math.max(maxLineWidth, ctx.measureText(l).width)
  ctx.font = secondaryFont
  for (const l of secondaryLines) maxLineWidth = Math.max(maxLineWidth, ctx.measureText(l).width)

  const groupGap = primaryLines.length > 0 && secondaryLines.length > 0 ? secondarySize * 0.3 : 0
  const textBlockHeight = primaryLines.length * primaryLineH + secondaryLines.length * secondaryLineH + groupGap

  const paddingX = primarySize * 0.6
  const paddingY = primarySize * 0.4
  const bottomMargin = height * CAPTION_BOTTOM_MARGIN_RATIO

  const boxWidth = Math.min(width, maxLineWidth + paddingX * 2)
  const boxHeight = textBlockHeight + paddingY * 2
  const boxX = (width - boxWidth) / 2
  const boxY = height - bottomMargin - boxHeight
  const centerX = width / 2

  ctx.fillStyle = 'rgba(0,0,0,0.55)'
  fillRoundedRect(ctx, boxX, boxY, boxWidth, boxHeight, 12)

  let y = boxY + paddingY
  ctx.font = primaryFont
  ctx.fillStyle = '#fff'
  for (const l of primaryLines) {
    y += primaryLineH
    ctx.fillText(l, centerX, y - (primaryLineH - primarySize) / 2)
  }
  if (groupGap) y += groupGap

  ctx.font = secondaryFont
  ctx.fillStyle = '#d8d8d8'
  for (const l of secondaryLines) {
    y += secondaryLineH
    ctx.fillText(l, centerX, y - (secondaryLineH - secondarySize) / 2)
  }
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

/** Resolves one slide's caption pair. `primary` is just speakerNotes,
 * gated on captions being enabled at all. `secondary` is only attempted
 * when there's a primary line to translate and a translation language is
 * selected that isn't already (approximately) the deck's own language —
 * `startsWith` rather than equality so a translation target like "en"
 * still skips a deck tagged "en-US". translateCaption hits its persistent
 * cache first, so a slide already translated during live playback resolves
 * here without a network round-trip. A translation failure degrades to no
 * secondary line rather than failing the whole export — except an
 * AbortError from a caller-cancelled `signal`, which must keep propagating
 * so exportJobs still sees the export as cancelled, not merely
 * caption-degraded. */
async function prepareCaptions(deck: Deck, slide: Slide, captionsEnabled: boolean, translationLang: string, signal?: AbortSignal): Promise<SlideCaptions> {
  if (!captionsEnabled) return { primary: null, secondary: null }
  const trimmed = slide.speakerNotes.trim()
  const primary = trimmed || null
  if (!primary || !translationLang || deck.lang.toLowerCase().startsWith(translationLang)) {
    return { primary, secondary: null }
  }
  try {
    const secondary = await translateCaption({ deckId: deck.id, slideId: slide.id, lang: translationLang, narration: primary, signal })
    return { primary, secondary }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err
    return { primary, secondary: null }
  }
}

async function prepareSlide(
  ctx: AudioContext,
  target: ResolvedNarrationTarget | null,
  slide: Slide,
  deck: Deck,
  total: number,
  captionsEnabled: boolean,
  translationLang: string,
  signal?: AbortSignal,
): Promise<SlideAssets> {
  const [png, narration, captions] = await Promise.all([
    renderSlideToPng(slide, deck.theme, total, 1),
    synthesizeSlideAudio(ctx, target, slide.speakerNotes),
    prepareCaptions(deck, slide, captionsEnabled, translationLang, signal),
  ])
  if (!png) throw new Error(`Failed to rasterize slide ${slide.index}`)
  const image = await loadImage(png)
  const segment = buildSegmentBuffer(ctx, narration, estimateFallbackMs(slide.speakerNotes))
  return { image, segment, captions }
}

/** One export backend's result: the finished video file and the extension
 * it should be downloaded as. */
interface ExportResult {
  blob: Blob
  ext: string
}

/** Feature/codec detection for the primary mediabunny/WebCodecs path.
 * Returns null (meaning: use the MediaRecorder fallback) when `VideoEncoder`
 * doesn't exist at all, or when the browser can't actually encode H.264 —
 * `getFirstEncodableVideoCodec`/`getFirstEncodableAudioCodec` are
 * mediabunny's own capability probes (they check `VideoEncoder`/
 * `AudioEncoder.isConfigSupported` under the hood), which is more reliable
 * than assuming `VideoEncoder`'s mere existence means every codec works.
 * Audio is optional here — `audioCodec` may resolve to null (no encodable
 * aac/opus) without disqualifying the WebCodecs path entirely; the export
 * just ends up video-only in that unlikely case. */
async function detectMediaBunnySupport(width: number, height: number): Promise<{ videoCodec: VideoCodec; audioCodec: AudioCodec | null } | null> {
  if (typeof VideoEncoder === 'undefined') return null
  try {
    const videoCodec = await getFirstEncodableVideoCodec(['avc'], { width, height, bitrate: MB_VIDEO_BITRATE })
    if (!videoCodec) return null
    const audioCodec = await getFirstEncodableAudioCodec(['aac', 'opus'], {
      numberOfChannels: 2,
      sampleRate: MB_AUDIO_SAMPLE_RATE,
      bitrate: MB_AUDIO_BITRATE,
    })
    return { videoCodec, audioCodec }
  } catch {
    return null
  }
}

/**
 * Primary export path: encodes the deck offline via mediabunny/WebCodecs
 * straight into a finalized in-memory MP4 (real `moov`, correct duration,
 * seekable). Unlike the MediaRecorder fallback, this does not run in real
 * time — nothing here waits on audio playback or a `captureStream` frame
 * rate; slides are rendered, captioned, and handed to the encoder as fast
 * as `CanvasSource.add`/`AudioBufferSource.add` can accept them, so an
 * export finishes in roughly the time it takes to synthesize narration and
 * encode, not the deck's narrated runtime.
 *
 * Each slide occupies one static image, but is still added to the video
 * track as several `MB_FRAME_STEP_SEC`-long frames back-to-back (all
 * sampling the same unchanged canvas) rather than a single frame spanning
 * the whole segment, so scrubbing within a slide in a player lands
 * somewhere reasonable instead of only being able to seek slide-to-slide.
 * Audio is normalized to stereo (see normalizeToStereo) at the
 * AudioContext's fixed 48 kHz sample rate (decodeAudioData resamples every
 * decoded narration clip to the context's rate automatically) before being
 * handed to `AudioBufferSource`, since mixing channel counts/sample rates
 * mid-track risks the encoder rejecting a later sample outright.
 */
async function exportViaMediaBunny(
  deck: Deck,
  canvas: HTMLCanvasElement,
  canvasCtx: CanvasRenderingContext2D,
  width: number,
  height: number,
  support: { videoCodec: VideoCodec; audioCodec: AudioCodec | null },
  onProgress?: (current: number, total: number) => void,
  signal?: AbortSignal,
): Promise<ExportResult> {
  const AudioContextCtor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioContextCtor) throw new Error('This browser does not support the Web Audio API.')
  const audioCtx = new AudioContextCtor({ sampleRate: MB_AUDIO_SAMPLE_RATE })

  try {
    await audioCtx.resume().catch(() => undefined)

    const config = loadLlmConfig()
    const target = config ? resolveNarrationTarget(config) : null

    // Same prefs PresentPlayer's live caption overlay reads — see the
    // header comment above for the full rationale.
    const captionsEnabled = loadCaptionsEnabled()
    const translationLang = captionsEnabled ? loadCaptionTranslationLang() : ''

    const total = deck.slides.length

    let nextAssets = await prepareSlide(audioCtx, target, deck.slides[0], deck, total, captionsEnabled, translationLang, signal)
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

    const bufferTarget = new BufferTarget()
    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
      target: bufferTarget,
    })

    const videoSource = new CanvasSource(canvas, {
      codec: support.videoCodec,
      bitrate: MB_VIDEO_BITRATE,
      latencyMode: 'quality',
      // Frequent key frames are what make seeking actually land on the
      // right picture: players recover video from the nearest preceding
      // key frame, and a deck's delta frames are near-empty (static slide
      // content), which some player/decoder combos won't repaint after a
      // seek until the next key frame arrives. Static content keeps the
      // size cost of 1s intervals modest. Paired with the forced key frame
      // on each slide's first frame below.
      keyFrameInterval: 1,
    })
    output.addVideoTrack(videoSource)

    const audioSource = support.audioCodec ? new AudioBufferSource({ codec: support.audioCodec, bitrate: MB_AUDIO_BITRATE }) : null
    if (audioSource) output.addAudioTrack(audioSource)

    await output.start()

    try {
      let cursor = 0
      for (let i = 0; i < total; i++) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
        onProgress?.(i + 1, total)
        const assets = nextAssets
        canvasCtx.drawImage(assets.image, 0, 0, width, height)
        drawCaptions(canvasCtx, width, height, assets.captions, deck.theme.fontFamily)

        // Kick off the next slide's render/TTS/translation now so it
        // overlaps with this slide's encoding below, rather than the two
        // running strictly back-to-back. Any rejection is pre-caught here
        // (mirroring the fallback path) so that if this iteration throws
        // before the prefetch is ever awaited, it doesn't surface as an
        // unhandled rejection.
        const prefetch = i + 1 < total ? prepareSlide(audioCtx, target, deck.slides[i + 1], deck, total, captionsEnabled, translationLang, signal) : null
        void prefetch?.catch(() => {})

        const segmentDuration = assets.segment.duration
        let remaining = segmentDuration
        let t = cursor
        let firstFrameOfSlide = true
        while (remaining > 1e-6) {
          const step = Math.min(MB_FRAME_STEP_SEC, remaining)
          // Force a key frame exactly at each slide boundary: a seek into
          // slide N then always has slide N's own image as its nearest
          // preceding key frame, so no player ever shows a stale slide (or
          // nothing) while audio keeps going.
          await videoSource.add(t, step, firstFrameOfSlide ? { keyFrame: true } : undefined)
          firstFrameOfSlide = false
          t += step
          remaining -= step
        }
        if (audioSource) {
          await audioSource.add(normalizeToStereo(assets.segment, audioCtx))
        }
        cursor += segmentDuration

        if (prefetch) nextAssets = await prefetch
      }
    } catch (err) {
      await output.cancel().catch(() => undefined)
      throw err
    }

    await output.finalize()
    const buffer = bufferTarget.buffer
    if (!buffer) throw new Error('mediabunny finished without producing an output buffer.')
    return { blob: new Blob([buffer], { type: 'video/mp4' }), ext: 'mp4' }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err
    throw new Error(`Video export failed while encoding via WebCodecs: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    await audioCtx.close().catch(() => undefined)
  }
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
 * Fallback export path for browsers with no usable WebCodecs H.264 encoder:
 * the original real-time `canvas.captureStream()` + `MediaRecorder`
 * recording. `onProgress(current, total)` fires once per slide, when
 * recording enters that slide's segment (1-based) — real-time, since the
 * recording takes as long as the narrated deck's total runtime (unlike
 * exportViaMediaBunny, which is not real-time).
 *
 * `signal`, when aborted, stops the export by throwing a DOMException named
 * 'AbortError'. Because a segment can play for several real-time seconds, a
 * per-slide-boundary check alone would leave cancellation feeling
 * unresponsive, so `playSegment` also watches `signal` directly and stops
 * the in-flight audio source immediately.
 *
 * Output here still carries the container limitations described in the
 * header comment above (no guaranteed `moov`/duration, `.webm` unless the
 * browser can record `video/mp4` directly) — this path is a last resort,
 * not a substitute for exportViaMediaBunny.
 */
async function exportViaMediaRecorder(
  deck: Deck,
  canvas: HTMLCanvasElement,
  canvasCtx: CanvasRenderingContext2D,
  width: number,
  height: number,
  onProgress?: (current: number, total: number) => void,
  signal?: AbortSignal,
): Promise<ExportResult> {
  if (typeof HTMLCanvasElement.prototype.captureStream !== 'function') {
    throw new Error('This browser does not support canvas.captureStream — video export is unavailable.')
  }
  const mimeType = pickMimeType()
  if (!mimeType) throw new Error('This browser has no supported MediaRecorder video format.')

  const total = deck.slides.length

  const AudioContextCtor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioContextCtor) throw new Error('This browser does not support the Web Audio API.')
  const audioCtx = new AudioContextCtor()

  let videoStream: MediaStream | null = null
  let combinedStream: MediaStream | null = null
  let recorder: MediaRecorder | null = null
  let redrawTimer: ReturnType<typeof window.setInterval> | null = null

  try {
    await audioCtx.resume().catch(() => undefined)
    const destination = audioCtx.createMediaStreamDestination()

    const config = loadLlmConfig()
    const target = config ? resolveNarrationTarget(config) : null

    // Same prefs PresentPlayer's live caption overlay reads — off entirely
    // unless the user has turned captions on, and secondary/translated
    // captions only attempted when a translation language is selected (see
    // prepareCaptions for the deck-language skip check).
    const captionsEnabled = loadCaptionsEnabled()
    const translationLang = captionsEnabled ? loadCaptionTranslationLang() : ''

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

    let nextAssets = await prepareSlide(audioCtx, target, deck.slides[0], deck, total, captionsEnabled, translationLang, signal)
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
    let currentCaptions: SlideCaptions | null = null
    redrawTimer = window.setInterval(() => {
      if (currentImage) {
        canvasCtx.drawImage(currentImage, 0, 0, width, height)
        drawCaptions(canvasCtx, width, height, currentCaptions, deck.theme.fontFamily)
      }
    }, 200)

    for (let i = 0; i < total; i++) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      onProgress?.(i + 1, total)
      const assets = nextAssets
      currentImage = assets.image
      currentCaptions = assets.captions
      canvasCtx.drawImage(assets.image, 0, 0, width, height)
      drawCaptions(canvasCtx, width, height, assets.captions, deck.theme.fontFamily)

      const prefetch =
        i + 1 < total ? prepareSlide(audioCtx, target, deck.slides[i + 1], deck, total, captionsEnabled, translationLang, signal) : null
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
    return { blob, ext }
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
  }
}

/**
 * Renders `deck` to a narrated slideshow video and triggers a browser
 * download. Prefers the offline WebCodecs/mediabunny path
 * (exportViaMediaBunny) when the browser can encode H.264, falling back to
 * a real-time MediaRecorder recording (exportViaMediaRecorder) otherwise —
 * see the header comment for why the former exists at all and what's wrong
 * with the latter as a primary path.
 *
 * `signal`, when aborted, stops the export by throwing a DOMException named
 * 'AbortError' — exportJobs.ts's runJob recognizes that name and settles the
 * job as `cancelled` rather than `failed`. The throw happens before the
 * download's `a.click()` below.
 */
export async function exportDeckToVideo(
  deck: Deck,
  onProgress?: (current: number, total: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (typeof document === 'undefined') throw new Error('Video export requires a browser environment.')
  if (typeof HTMLCanvasElement === 'undefined') throw new Error('This browser does not support the canvas APIs video export needs.')

  const total = deck.slides.length
  if (total === 0) throw new Error('Deck has no slides to export.')

  const width = WIDTH
  const height = deck.theme.aspectRatio === '4:3' ? Math.round((WIDTH * 3) / 4) : Math.round((WIDTH * 9) / 16)

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const canvasCtx = canvas.getContext('2d')
  if (!canvasCtx) throw new Error('Failed to acquire a 2D canvas context.')

  const support = await detectMediaBunnySupport(width, height)
  const result = support
    ? await exportViaMediaBunny(deck, canvas, canvasCtx, width, height, support, onProgress, signal)
    : await exportViaMediaRecorder(deck, canvas, canvasCtx, width, height, onProgress, signal)

  let objectUrl: string | null = null
  try {
    objectUrl = URL.createObjectURL(result.blob)
    const a = document.createElement('a')
    a.href = objectUrl
    a.download = `${sanitizeFilename(deck.title)}.${result.ext}`
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
    if (objectUrl) URL.revokeObjectURL(objectUrl)
  }
}

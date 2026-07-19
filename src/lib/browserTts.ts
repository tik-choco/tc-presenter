// Web Speech API (speechSynthesis) wrapper — the 'browser' narration engine
// (features/present/ttsTarget.ts's ResolvedNarrationTarget 'browser'
// variant), for speaking with the OS's built-in synthesizer when no
// LLM/TTS provider is involved (unlike the HTTP-based lib/tts.ts).
//
// Known Chrome bug worked around here: a single long SpeechSynthesisUtterance
// silently stops partway through once its text passes a few hundred
// characters — `onend` fires without the whole text having been spoken, with
// no `onerror`. The workaround is to split text into sentence-sized chunks
// and speak them sequentially, chaining each chunk's `onend` to the next
// chunk's `speak()` call, so no single utterance is ever long enough to
// trigger the bug.

/** Chrome's silent-truncation bug reliably avoids this length; kept well
 * under the (undocumented, version-dependent) threshold with margin. */
const MAX_CHUNK_LENGTH = 200

/** How long to wait for the async `voiceschanged` event before giving up and
 * resolving with whatever `getVoices()` returns at that point (possibly
 * empty) — some browsers populate the voice list lazily on first access. */
const VOICES_READY_TIMEOUT_MS = 2000

export function isBrowserTtsSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.speechSynthesis !== 'undefined' &&
    typeof SpeechSynthesisUtterance !== 'undefined'
  )
}

/**
 * Resolves the list of available voices, waiting for the async
 * `voiceschanged` event if `getVoices()` starts out empty (common on first
 * call in Chrome). Times out after ~2s and resolves with whatever is
 * available then — never rejects, even if the list stays empty.
 */
export function listBrowserVoices(): Promise<SpeechSynthesisVoice[]> {
  if (!isBrowserTtsSupported()) return Promise.resolve([])

  const synth = window.speechSynthesis
  const existing = synth.getVoices()
  if (existing.length > 0) return Promise.resolve(existing)

  return new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      synth.removeEventListener('voiceschanged', onVoicesChanged)
      clearTimeout(timer)
      resolve(synth.getVoices())
    }
    const onVoicesChanged = () => finish()
    synth.addEventListener('voiceschanged', onVoicesChanged)
    const timer = setTimeout(finish, VOICES_READY_TIMEOUT_MS)
  })
}

/** Splits text into sentences on common sentence-ending punctuation
 * (Japanese and Western, full-width and half-width) and newlines, keeping the
 * delimiter attached to the sentence it ends. */
function splitIntoSentences(text: string): string[] {
  return text
    .split(/(?<=[。．.!?！？\n])/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0)
}

/** Further splits a single sentence that exceeds `MAX_CHUNK_LENGTH`, breaking
 * on the nearest preceding space when one exists so words aren't split, and
 * hard-cutting otherwise (e.g. for languages with no spaces). */
function splitLongSentence(sentence: string): string[] {
  if (sentence.length <= MAX_CHUNK_LENGTH) return [sentence]

  const chunks: string[] = []
  let remaining = sentence
  while (remaining.length > MAX_CHUNK_LENGTH) {
    const spaceCut = remaining.lastIndexOf(' ', MAX_CHUNK_LENGTH)
    const cut = spaceCut > 0 ? spaceCut : MAX_CHUNK_LENGTH
    chunks.push(remaining.slice(0, cut).trim())
    remaining = remaining.slice(cut).trim()
  }
  if (remaining.length > 0) chunks.push(remaining)
  return chunks
}

function chunkText(text: string): string[] {
  return splitIntoSentences(text).flatMap(splitLongSentence)
}

export interface BrowserSpeechHandle {
  play(): void
  pause(): void
  resume(): void
  /** Cancels playback and suppresses any further `onEnd`/`onError` calls. */
  stop(): void
  /** Updates the utterance rate for subsequent chunks. The chunk currently
   * being spoken keeps its original rate (the Web Speech API can't change an
   * in-flight utterance) — chunked playback means the new rate takes effect
   * within a sentence or so. */
  setRate(rate: number): void
}

/**
 * Builds a chunked-playback handle around `params.text`. Nothing is spoken
 * until `play()` is called. If `isBrowserTtsSupported()` is false, `play()`
 * asynchronously calls `onError` instead of speaking.
 */
export function createBrowserSpeech(params: {
  text: string
  /** Set on each utterance (voice-selection hint when `voiceURI` is absent/unmatched). */
  lang?: string
  /** Matched against `speechSynthesis.getVoices()[].voiceURI`. Falls back to `lang`-only selection if no match is found. */
  voiceURI?: string
  rate?: number
  pitch?: number
  /** Called once, after the final chunk finishes. */
  onEnd: () => void
  onError: (error: unknown) => void
}): BrowserSpeechHandle {
  const chunks = chunkText(params.text)
  let stopped = false
  let chunkIndex = 0
  // Mutable so `setRate()` can update it; read fresh in `speakNextChunk()` on
  // every chunk so a rate change takes effect starting with the next chunk.
  let rate = params.rate

  function resolveVoice(): SpeechSynthesisVoice | undefined {
    if (!params.voiceURI) return undefined
    return window.speechSynthesis.getVoices().find((voice) => voice.voiceURI === params.voiceURI)
  }

  function speakNextChunk() {
    if (stopped) return
    if (chunkIndex >= chunks.length) {
      params.onEnd()
      return
    }

    const utterance = new SpeechSynthesisUtterance(chunks[chunkIndex])
    chunkIndex += 1

    if (params.lang) utterance.lang = params.lang
    if (rate !== undefined) utterance.rate = rate
    if (params.pitch !== undefined) utterance.pitch = params.pitch
    const voice = resolveVoice()
    if (voice) utterance.voice = voice

    utterance.onend = () => {
      if (stopped) return
      speakNextChunk()
    }
    utterance.onerror = (event) => {
      if (stopped) return
      // `stop()` and the cancel()-before-play() cleanup both surface here as
      // 'canceled'/'interrupted' in most browsers — those are our own doing,
      // not a real failure, so they must not reach the caller's onError.
      if (event.error === 'canceled' || event.error === 'interrupted') return
      params.onError(event.error ?? event)
    }

    window.speechSynthesis.speak(utterance)
  }

  return {
    play() {
      if (!isBrowserTtsSupported()) {
        setTimeout(() => {
          if (!stopped) params.onError(new Error('Browser speech synthesis is not supported in this environment.'))
        }, 0)
        return
      }

      stopped = false
      chunkIndex = 0
      window.speechSynthesis.cancel() // clear out any other utterance in flight first
      if (chunks.length === 0) {
        setTimeout(() => {
          if (!stopped) params.onEnd()
        }, 0)
        return
      }
      speakNextChunk()
    },
    pause() {
      if (isBrowserTtsSupported()) window.speechSynthesis.pause()
    },
    resume() {
      if (isBrowserTtsSupported()) window.speechSynthesis.resume()
    },
    stop() {
      stopped = true // set before cancel(): cancel() can synchronously/soon fire onerror/onend for the in-flight chunk
      if (isBrowserTtsSupported()) window.speechSynthesis.cancel()
    },
    setRate(next) {
      rate = next
    },
  }
}

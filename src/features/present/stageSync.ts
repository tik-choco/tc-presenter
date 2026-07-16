// Presenter-tool <-> stage-window sync for the Present feature.
//
// The Present tab can split into two windows: the main window becomes the
// presenter tool (controls, speaker notes, next-slide preview, narration
// playback) and a popup "stage window" (`?window=stage`) renders only the
// slide for the audience/projector. This module is the single contract both
// sides code against: a same-origin BroadcastChannel carrying full-state
// snapshots from the presenter to the stage, and a `hello` handshake from
// the stage asking for the current state when it (re)loads.
//
// Design notes:
// - The presenter is the single source of truth. It owns playback (TTS
//   audio stays in the presenter window — same machine, same speakers) and
//   broadcasts a complete `StageState` on every change; the stage is a dumb
//   renderer with no state of its own beyond the last snapshot received.
//   Full snapshots (not deltas) make the protocol self-healing: a stage
//   window opened late, reloaded, or briefly frozen catches up from the
//   next message alone.
// - `Deck` is plain structured-clonable JSON (see types.ts), so it rides
//   BroadcastChannel directly; no serialization layer needed. Presenter
//   character settings are NOT part of the state — the stage window shares
//   the origin's localStorage and loads them itself (vrm/characterSettings);
//   only the live `speaking` lip-sync signal must be synced.
// - This channel is intentionally separate from lib/sharedBus.ts: that bus
//   is the versioned cross-app family contract, while this is a private,
//   same-app, same-tab-family wire that can evolve freely with this feature.
import type { Deck } from '../../types'

/** URL query param that marks a window as the stage renderer. */
export const STAGE_WINDOW_QUERY = 'window'
export const STAGE_WINDOW_VALUE = 'stage'

const CHANNEL_NAME = 'tc-presenter-stage-v1'

/** Complete render state for the stage window — always sent whole. */
export interface StageState {
  deck: Deck
  currentIndex: number
  /** Total build stages in the current slide's build group, if any
   * (mirrors PresentPlayer's `buildStageTotal` memo — computed presenter-side
   * so the stage needn't re-derive it). */
  buildStageTotal?: number
  showCaptions: boolean
  /** True while narration is actively advancing — drives stage lip-sync. */
  speaking: boolean
  /** True while the presenter shows the slide-overview grid (Q&A) — mirrored
   * on the stage so the audience sees the same grid. */
  gridVisible: boolean
}

export type PresenterMessage =
  | { v: 1; type: 'state'; state: StageState }
  /** Presentation ended / presenter exited — stage shows its ended screen. */
  | { v: 1; type: 'end' }

export type StageMessage =
  /** Sent by a stage window on load (and reload) to request a state snapshot. */
  { v: 1; type: 'hello' }

/** True when the current window was opened as the stage renderer
 * (`?window=stage`) — checked by main.tsx to swap the app shell out. */
export function isStageWindow(): boolean {
  try {
    return new URLSearchParams(window.location.search).get(STAGE_WINDOW_QUERY) === STAGE_WINDOW_VALUE
  } catch {
    return false
  }
}

/** Stage-window URL for this deployment (preserves the app's base path). */
export function buildStageWindowUrl(): string {
  const url = new URL(window.location.href)
  url.hash = ''
  url.search = ''
  url.searchParams.set(STAGE_WINDOW_QUERY, STAGE_WINDOW_VALUE)
  return url.toString()
}

/** Opens (or refocuses — shared window name) the stage window. Returns null
 * when the browser blocks the popup; callers should surface
 * `present.stagePopupBlocked` in that case. */
export function openStageWindow(): Window | null {
  try {
    return window.open(buildStageWindowUrl(), 'tc-presenter-stage')
  } catch {
    return null
  }
}

export interface PresenterEndpoint {
  /** Broadcast a full state snapshot (call on every relevant change). */
  publish(state: StageState): void
  /** Tell stage windows the presentation is over (they show `present.ended`). */
  end(): void
  /** Release the channel. Does NOT send `end` — call that first if intended. */
  close(): void
}

/** Presenter side. `onHello` fires whenever a stage window (re)connects —
 * respond by `publish`ing the current state. */
export function createPresenterEndpoint(onHello: () => void): PresenterEndpoint {
  const channel = new BroadcastChannel(CHANNEL_NAME)
  channel.onmessage = (event: MessageEvent<StageMessage>) => {
    if (event.data?.v === 1 && event.data.type === 'hello') onHello()
  }
  return {
    publish(state) {
      const message: PresenterMessage = { v: 1, type: 'state', state }
      channel.postMessage(message)
    },
    end() {
      const message: PresenterMessage = { v: 1, type: 'end' }
      channel.postMessage(message)
    },
    close() {
      channel.close()
    },
  }
}

export interface StageEndpoint {
  /** Release the channel (stage window unmount/unload). */
  close(): void
}

/** Stage side. Sends `hello` immediately; snapshots then arrive via
 * `onState`, and `onEnd` signals the presenter finished/exited. */
export function createStageEndpoint(handlers: {
  onState: (state: StageState) => void
  onEnd: () => void
}): StageEndpoint {
  const channel = new BroadcastChannel(CHANNEL_NAME)
  channel.onmessage = (event: MessageEvent<PresenterMessage>) => {
    const data = event.data
    if (data?.v !== 1) return
    if (data.type === 'state') handlers.onState(data.state)
    else if (data.type === 'end') handlers.onEnd()
  }
  const hello: StageMessage = { v: 1, type: 'hello' }
  channel.postMessage(hello)
  return {
    close() {
      channel.close()
    },
  }
}

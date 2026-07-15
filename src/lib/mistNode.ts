// Single shared MistNode for the whole app. Originally written as
// globalArticlesNode.ts (a feature-scoped singleton for the tc-global-
// articles P2P subscription only); promoted to this app-wide module so
// lib/aiNetwork.ts's AI Network role can share the same real node instead of
// instantiating its own — see the SharedMistNode adapter below.
//
// Vendored + trimmed from tc-news's src/lib/mistClient.ts (see
// notes-tc-news.md §3(a) / notes-mistlib.md): mistlib-wasm only supports one
// active MistNode per page (its storage_add/storage_get/etc. are
// page-global wasm exports, not tied to a specific instance, and
// node.onEvent() accepts a single handler that replaces any previous one),
// so this module owns the one real instance and fans its raw events out to
// any number of listeners via subscribeEvent().
//
// Two independent consumers share this node today:
//  - lib/globalArticlesReader.ts uses getNode()/subscribeEvent() directly —
//    it already does its own roomId filtering and explicit-roomId
//    leaveRoom(), so it doesn't need an adapter.
//  - lib/aiNetwork.ts uses the SharedMistNode adapter below (implementing
//    @tik-choco/mistai's MistNodeLike), because mistai's Network/
//    ConsumerClient/useNetworkProvider are designed to own a dedicated node
//    per session: they call onEvent() once (replacing any previous handler)
//    and leaveRoom() with no roomId argument. Handing them the real node
//    directly would clobber this module's event fan-out and tear the whole
//    node down when only the AI Network session meant to leave. This is the
//    same adapter shape tc-news's own src/lib/network.ts uses to share its
//    mistClient.ts singleton with @tik-choco/mistai.

import { MistNode, EVENT_RAW, storage_get, DELIVERY_RELIABLE } from '../vendor/mistlib/wrappers/web/index.js'
import { safeSetItem } from './safeStorage'

export { DELIVERY_RELIABLE, storage_get }

const NODE_ID_STORAGE_KEY = 'tc-presenter:mist-node-id-v1'

function randomId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `mn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  }
}

/** Persistent id for this app's single shared MistNode. */
export function localNodeId(): string {
  try {
    const existing = localStorage.getItem(NODE_ID_STORAGE_KEY)
    if (existing) return existing
  } catch {
    // localStorage unavailable — fall through to an unpersisted id below
  }
  const id = randomId()
  safeSetItem(NODE_ID_STORAGE_KEY, id)
  return id
}

type EventListener = (eventType: number, fromId: string, payload: unknown, roomId: string) => void

let node: InstanceType<typeof MistNode> | null = null
let initPromise: Promise<InstanceType<typeof MistNode>> | null = null
const eventListeners = new Set<EventListener>()

/** Lazily creates (at most once) and returns the app's single MistNode. */
export async function getNode(): Promise<InstanceType<typeof MistNode>> {
  if (node) return node
  if (!initPromise) {
    initPromise = (async () => {
      const n = new MistNode(localNodeId())
      await n.init()
      n.onEvent((eventType, fromId, payload, roomId) => {
        eventListeners.forEach((l) => l(eventType, fromId, payload, roomId ?? ''))
      })
      node = n
      return n
    })()
  }
  return initPromise
}

/** Returns an unsubscribe function. */
export function subscribeEvent(listener: EventListener): () => void {
  eventListeners.add(listener)
  return () => eventListeners.delete(listener)
}

export function decodeRawPayload(payload: unknown): unknown | null {
  try {
    const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload as ArrayBuffer)
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return null
  }
}

export function isRawEvent(eventType: number): boolean {
  return eventType === EVENT_RAW
}

// ---------------------------------------------------------------------------
// SharedMistNode: MistNodeLike adapter for @tik-choco/mistai (lib/aiNetwork.ts)

/** Structural subset of @tik-choco/mistai's MistNodeLike this adapter
 * implements — kept local (rather than imported from the package) so this
 * file has no dependency on @tik-choco/mistai's types. */
interface MistNodeLikeAdapter {
  init(): Promise<void>
  onEvent(handler: (eventType: number, fromId: string, payload: unknown) => void): void
  joinRoom(roomId: string): void
  leaveRoom(): void
  sendMessage(toId: string | null | undefined, payload: Uint8Array, delivery?: number): void
}

// The AI Network consumer session and provider session (lib/aiNetwork.ts)
// typically share one room on the one real node, but each SharedMistNode
// instance tears its own session down independently — refcount the physical
// room joins so disabling one role doesn't yank the room out from under the
// other. Note: lib/globalArticlesReader.ts's room joins are NOT tracked
// here — it manages tc-global-articles's membership directly against the
// real node (see its own header comment) — so this map only coordinates
// between multiple SharedMistNode instances, which today only lib/
// aiNetwork.ts creates.
const roomRefCounts = new Map<string, number>()

/**
 * Adapter that lets @tik-choco/mistai's Network class (via ConsumerClient /
 * useNetworkProvider) drive a *session* while this module's getNode() stays
 * the sole owner of the real MistNode. See the header comment for why a
 * direct handoff of the real node doesn't work.
 */
export class SharedMistNode implements MistNodeLikeAdapter {
  private realNode: InstanceType<typeof MistNode> | null = null
  private roomId: string | null = null
  private joinPromise: Promise<void> | null = null
  private unsubscribe: (() => void) | null = null

  async init(): Promise<void> {
    this.realNode = await getNode()
  }

  onEvent(handler: (eventType: number, fromId: string, payload: unknown) => void): void {
    this.unsubscribe?.()
    this.unsubscribe = subscribeEvent((eventType, fromId, payload, roomId) => {
      if (this.roomId !== null && roomId !== this.roomId) return
      handler(eventType, fromId, payload)
    })
  }

  joinRoom(roomId: string): void {
    this.roomId = roomId
    roomRefCounts.set(roomId, (roomRefCounts.get(roomId) ?? 0) + 1)
    // mistai's Network broadcasts a hello as soon as this (void) method
    // returns, but the wasm node rejects sendMessage for a room whose
    // session isn't built yet. Join with the awaitable variant and let
    // sendMessage() below queue behind it.
    this.joinPromise = this.realNode
      ? this.realNode.joinRoomAsync(roomId).catch((err: unknown) => {
          console.warn('tc-presenter: AI Network room join failed', err)
        })
      : null
  }

  leaveRoom(): void {
    const roomId = this.roomId
    this.unsubscribe?.()
    this.unsubscribe = null
    this.roomId = null
    this.joinPromise = null
    if (!roomId) return
    // Last session out actually leaves. Explicit roomId only — the real
    // node's parameterless leaveRoom() would deinitialize every room this
    // app has joined, including the global articles room.
    const remaining = (roomRefCounts.get(roomId) ?? 1) - 1
    if (remaining > 0) {
      roomRefCounts.set(roomId, remaining)
      return
    }
    roomRefCounts.delete(roomId)
    this.realNode?.leaveRoom(roomId)
  }

  sendMessage(toId: string | null | undefined, payload: Uint8Array, delivery?: number): void {
    const realNode = this.realNode
    const roomId = this.roomId
    if (!realNode || roomId === null) return
    const send = () => {
      // Dropped if the session left the room while the join was in flight.
      if (this.roomId !== roomId) return
      realNode.sendMessage(toId, payload, delivery, roomId)
    }
    if (this.joinPromise) void this.joinPromise.then(send)
    else send()
  }
}

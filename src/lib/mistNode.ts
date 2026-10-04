// The article reader and mistai share one physical MistNode. This module
// fans out the wrapper's single event handler; mistai owns AI room handles.
import { MistNode, EVENT_RAW, storage_get, DELIVERY_RELIABLE } from '../vendor/mistlib/wrappers/web/index.js'
import { safeSetItem } from './safeStorage'
import { mistSignalingConfig } from './mistSignaling'

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
      // inviteSalt/inviteCode scope peer discovery to the tik-choco family
      // namespace — without them this node can't find any other app's peers.
      const n = new MistNode(localNodeId(), mistSignalingConfig())
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

// Bridge the existing article transport to mistai's shared scope. Mistai owns
// AI room reference counts; article subscriptions keep their own membership.
export class SharedMistNode {
  private realNode: InstanceType<typeof MistNode> | null = null
  async init(): Promise<void> { this.realNode = await getNode() }
  onEvent(handler: EventListener): void { subscribeEvent(handler) }
  joinRoom(roomId: string): Promise<void> { return this.joinRoomAsync(roomId) }
  async joinRoomAsync(roomId: string): Promise<void> { await this.realNode?.joinRoomAsync(roomId) }
  leaveRoom(roomId?: string): void { if (roomId) this.realNode?.leaveRoom(roomId) }
  sendMessage(toId: string | null | undefined, payload: Uint8Array, delivery?: number, roomId?: string): void {
    this.realNode?.sendMessage(toId, payload, delivery, roomId)
  }
}

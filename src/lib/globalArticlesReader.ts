// Vendored + adapted from tc-news's src/lib/globalArticlesReader.ts (see
// notes-tc-news.md §3(a)): subscribe-only client for the tik-choco family's
// well-known global article room. Depends on the sibling globalArticlesSign/
// globalArticlesWire modules (no hooks, no view code — mirroring the
// upstream file's intentionally self-contained design) plus lib/mistNode.ts
// for the actual MistNode, which — unlike the rest of this trio — is a
// general, app-wide singleton shared with lib/aiNetwork.ts's AI Network
// role rather than a globalArticles-only module (see mistNode.ts's header
// comment for why).
//
// Trimmed from the upstream file: forwardWireToGlobal/forwardArticleToGlobal
// are omitted — tc-presenter only reads this room, it never publishes an
// article of its own into it.
//
// Extended from the upstream file: subscribeGlobalArticles takes an optional
// `onStatusChange` callback so the Sources tab can show a real connecting/
// connected/error state — tc-presenter has no useNewsRoom-style hook of its
// own to derive that from.
//
// Every failure path below is caught locally (console.error/console.warn) —
// nothing here throws past subscribeGlobalArticles()'s own boundary, and the
// returned unsubscribe function never throws either.
import {
  getNode,
  subscribeEvent,
  isRawEvent,
  decodeRawPayload,
  storage_get,
  localNodeId,
  DELIVERY_RELIABLE,
} from './mistNode'
import { verifyWire } from './globalArticlesSign'
import {
  GLOBAL_ARTICLES_ROOM_ID,
  appendWireLog,
  loadWireLog,
  type ArticleWire,
  type HistoryRequestWire,
  type NewsArticle,
} from './globalArticlesWire'

export type { NewsArticle, ArticleWire }

// Mirrors tc-news's useNewsRoom.ts replay pacing so a peer that only joins
// the global room (via this reader) behaves like a private-room peer.
const HISTORY_ANSWER_THROTTLE_MS = 60_000
const HISTORY_REQUEST_DELAY_MS = 700
const REPLAY_STAGGER_MS = 40

export type GlobalArticlesStatus = { phase: 'connecting' } | { phase: 'connected' } | { phase: 'error'; message: string }

function isArticleWirePayload(value: unknown): value is ArticleWire {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    v.type === 'tc-news:article' &&
    typeof v.id === 'string' &&
    typeof v.fromId === 'string' &&
    typeof v.fromName === 'string' &&
    typeof v.timestamp === 'number' &&
    typeof v.cid === 'string' &&
    typeof v.signature === 'string' &&
    (v.fromApp === undefined || typeof v.fromApp === 'string')
  )
}

function isHistoryRequestPayload(value: unknown): value is HistoryRequestWire {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return v.type === 'tc-news:history-request' && typeof v.fromId === 'string' && typeof v.timestamp === 'number'
}

function sanitizeArticleCandidate(value: unknown): NewsArticle | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (typeof v.id !== 'string' || !v.id) return null
  if (typeof v.title !== 'string') return null
  if (typeof v.body !== 'string') return null
  if (typeof v.authorDid !== 'string') return null
  if (typeof v.createdAt !== 'number') return null
  return {
    id: v.id,
    title: v.title,
    excerpt: typeof v.excerpt === 'string' ? v.excerpt : '',
    body: v.body,
    tags: Array.isArray(v.tags) ? v.tags.filter((t): t is string => typeof t === 'string') : [],
    sourceLinks: Array.isArray(v.sourceLinks)
      ? v.sourceLinks.filter(
          (s): s is { title: string; url: string } =>
            !!s && typeof s === 'object' && typeof (s as Record<string, unknown>).title === 'string' && typeof (s as Record<string, unknown>).url === 'string',
        )
      : [],
    authorDid: v.authorDid,
    authorName: typeof v.authorName === 'string' ? v.authorName : '',
    createdAt: v.createdAt,
    cid: typeof v.cid === 'string' ? v.cid : undefined,
    shared: typeof v.shared === 'boolean' ? v.shared : undefined,
    lang: typeof v.lang === 'string' && v.lang ? v.lang : undefined,
    imageUrl: typeof v.imageUrl === 'string' && v.imageUrl ? v.imageUrl : undefined,
  }
}

/**
 * Subscribe-only: joins the global article room and hands verified articles
 * to `onArticle`. Persistence of received articles is the caller's
 * responsibility — this function only verifies and decodes. `onStatusChange`
 * (optional) reports connecting/connected/error transitions for UI. Returns
 * an unsubscribe function that also leaves the room; safe to call multiple
 * times and safe to call before the initial join settles.
 */
export function subscribeGlobalArticles(
  onArticle: (article: NewsArticle, wire: ArticleWire) => void,
  onStatusChange?: (status: GlobalArticlesStatus) => void,
): () => void {
  let cancelled = false
  const roomId = GLOBAL_ARTICLES_ROOM_ID
  const answeredAt = new Map<string, number>()
  // Dedupe within this subscription's lifetime only (no persisted list here
  // — the caller owns storage, per this function's contract).
  const seenIds = new Set<string>()

  function reportStatus(status: GlobalArticlesStatus) {
    if (cancelled) return
    try {
      onStatusChange?.(status)
    } catch (err) {
      console.error('tc-presenter: global articles status callback threw', err)
    }
  }

  async function hydrate(wire: ArticleWire) {
    try {
      if (seenIds.has(wire.id)) return // duplicate, ignore
      if (!(await verifyWire(wire))) {
        console.warn('discarding global article wire with invalid signature', wire.id)
        return
      }
      appendWireLog(roomId, wire)
      const bytes = await storage_get(wire.cid)
      if (cancelled) return
      const candidate = sanitizeArticleCandidate(JSON.parse(new TextDecoder().decode(bytes)))
      if (!candidate) return
      if (candidate.authorDid !== wire.fromId) {
        console.warn('discarding global article wire: authorDid does not match wire fromId', wire.id)
        return
      }
      if (seenIds.has(candidate.id)) return // duplicate, ignore
      seenIds.add(candidate.id)
      onArticle({ ...candidate, shared: true }, wire)
    } catch (err) {
      console.error('failed to hydrate global article', err)
    }
  }

  function replayHistoryTo(requesterId: string) {
    const now = Date.now()
    if (now - (answeredAt.get(requesterId) ?? 0) < HISTORY_ANSWER_THROTTLE_MS) return
    answeredAt.set(requesterId, now)
    const log = loadWireLog(roomId)
    if (log.length === 0) return
    getNode()
      .then((node) => {
        log.forEach((wire, index) => {
          setTimeout(() => {
            if (cancelled) return
            try {
              node.sendMessage(requesterId, wire, DELIVERY_RELIABLE, roomId)
            } catch (err) {
              console.error('failed to replay global article wire', err)
            }
          }, index * REPLAY_STAGGER_MS)
        })
      })
      .catch((err: unknown) => {
        console.error('failed to resolve node while replaying global article history', err)
      })
  }

  const unsubscribe = subscribeEvent((eventType, fromId, payload, evtRoomId) => {
    if (cancelled) return
    if (!isRawEvent(eventType)) return
    if (evtRoomId && evtRoomId !== roomId) return // not this room's traffic
    const decoded = decodeRawPayload(payload)
    if (isArticleWirePayload(decoded)) {
      hydrate(decoded)
    } else if (isHistoryRequestPayload(decoded)) {
      replayHistoryTo(fromId)
    }
  })

  let historyRequestTimer: ReturnType<typeof setTimeout> | undefined

  reportStatus({ phase: 'connecting' })
  ;(async () => {
    try {
      const node = await getNode()
      if (cancelled) return
      await node.joinRoomAsync(roomId)
      if (cancelled) return
      reportStatus({ phase: 'connected' })
      historyRequestTimer = setTimeout(() => {
        if (cancelled) return
        const request: HistoryRequestWire = {
          type: 'tc-news:history-request',
          fromId: localNodeId(),
          timestamp: Date.now(),
        }
        try {
          node.sendMessage(null, request, DELIVERY_RELIABLE, roomId)
        } catch (err) {
          console.error('failed to send global articles history request', err)
        }
      }, HISTORY_REQUEST_DELAY_MS)
    } catch (err) {
      console.error('failed to join global articles room', err)
      reportStatus({ phase: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  })()

  return () => {
    cancelled = true
    if (historyRequestTimer) clearTimeout(historyRequestTimer)
    unsubscribe()
    getNode()
      .then((node) => node.leaveRoom(roomId))
      .catch(() => {})
  }
}

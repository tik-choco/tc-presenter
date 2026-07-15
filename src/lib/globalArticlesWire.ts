// Vendored + trimmed from tc-news's src/lib/newsWire.ts (see
// notes-tc-news.md §3(a)): only the pieces globalArticlesReader.ts needs to
// read (never write/sign) the well-known `tc-global-articles` room — the
// room id, the ArticleWire/HistoryRequestWire wire shapes, the NewsArticle
// payload an ArticleWire's CID resolves to, and the local wireLog used to
// replay history to newcomers (this app becomes a normal read-only
// participant: any wire it verifies and hydrates is also recorded here so it
// can help replay history to a peer that joins after it, exactly like a
// real tc-news client would).
import { safeSetItem } from './safeStorage'

/** Well-known global article room id shared by the whole tik-choco family. */
export const GLOBAL_ARTICLES_ROOM_ID = 'tc-global-articles'

export interface ArticleWire extends Record<string, unknown> {
  type: 'tc-news:article'
  id: string // article.id
  fromId: string // sender DID
  fromName: string
  timestamp: number
  cid: string // CID of the full NewsArticle JSON
  signature: string
  fromApp?: string
}

export interface HistoryRequestWire extends Record<string, unknown> {
  type: 'tc-news:history-request'
  fromId: string
  timestamp: number
}

/** The payload an ArticleWire's `cid` resolves to via storage_get(). Mirrors
 * tc-news's src/types.ts NewsArticle, trimmed to the fields this reader
 * actually consumes (category/origin aren't needed to turn an article into
 * a SourceMaterial). */
export interface NewsArticle {
  id: string
  title: string
  excerpt: string
  body: string
  tags: string[]
  sourceLinks: { title: string; url: string }[]
  authorDid: string
  authorName: string
  createdAt: number
  cid?: string
  shared?: boolean
  lang?: string
  imageUrl?: string
}

/** tc-presenter never emits or forwards a TranslationWire, and
 * subscribeGlobalArticles only ever logs ArticleWire — so, unlike tc-news's
 * own newsWire.ts, this trimmed NewsWire alias is just ArticleWire. */
export type NewsWire = ArticleWire

const WIRE_LOG_KEY_PREFIX = 'tc-presenter:global-articles-wirelog:'
const MAX_WIRE_LOG = 300

function isArticleWire(value: unknown): value is ArticleWire {
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

export function loadWireLog(roomId: string): NewsWire[] {
  try {
    const raw = localStorage.getItem(WIRE_LOG_KEY_PREFIX + roomId)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isArticleWire)
  } catch {
    return []
  }
}

/** Records a signed wire for later replay, deduped by wire id. */
export function appendWireLog(roomId: string, wire: NewsWire): void {
  const log = loadWireLog(roomId)
  if (log.some((w) => w.id === wire.id)) return
  const next = [...log, wire]
  const trimmed = next.length > MAX_WIRE_LOG ? next.slice(next.length - MAX_WIRE_LOG) : next
  safeSetItem(WIRE_LOG_KEY_PREFIX + roomId, JSON.stringify(trimmed))
}

// Opt-in preference + subscription lifecycle for tc-news's well-known P2P
// "global articles" room (GLOBAL_ARTICLES_ROOM_ID = "tc-global-articles",
// see notes-tc-news.md §3(a)) in addition to the same-origin sharedBus
// `note-article` channel handled by newsArticleAdapter.ts.
//
// This module owns:
//  - persisting the user's opt-in choice (localStorage, unchanged from the
//    original placeholder version of this file)
//  - starting/stopping the actual P2P subscription (lib/globalArticlesReader
//    .ts, vendored from tc-news — its MistNode now comes from lib/mistNode
//    .ts, the single app-wide node shared with lib/aiNetwork.ts's AI Network
//    role; see mistNode.ts's header comment for how that sharing works)
//  - converting each verified article into a SourceMaterial via
//    newsArticleAdapter.ts and reporting a simple connecting/connected/error
//    status the Sources tab can render
//
// Every function here follows the rest of the codebase's convention of
// never throwing past its own boundary — startGlobalArticlesSubscription's
// returned unsubscribe function is always safe to call, and connection
// failures surface via `onStatus`, never as a rejected promise or thrown
// error the caller has to handle.

import { subscribeGlobalArticles, type GlobalArticlesStatus } from '../../lib/globalArticlesReader'
import { sourceMaterialFromGlobalArticle } from './newsArticleAdapter'
import type { SourceMaterial } from '../../types'

const STORAGE_KEY = 'tc-presenter:global-articles-opt-in'

export function loadGlobalArticlesOptIn(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

export function saveGlobalArticlesOptIn(enabled: boolean): void {
  try {
    if (enabled) localStorage.setItem(STORAGE_KEY, '1')
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    // best-effort persistence only, matches every other module's convention
  }
}

export type GlobalArticlesConnectionPhase = 'connecting' | 'connected' | 'error'

export interface GlobalArticlesConnectionState {
  phase: GlobalArticlesConnectionPhase
  message?: string
}

/**
 * Starts the P2P subscription: `onMaterial` fires once per newly hydrated
 * (signature-verified) article, converted to a SourceMaterial; `onStatus`
 * fires on every connection phase transition. Returns an unsubscribe
 * function that also leaves the room. Safe to call unconditionally when the
 * user enables the toggle — every failure inside subscribeGlobalArticles is
 * caught there and reported as an 'error' status instead of throwing.
 */
export function startGlobalArticlesSubscription(
  onMaterial: (material: SourceMaterial) => void,
  onStatus: (state: GlobalArticlesConnectionState) => void,
): () => void {
  return subscribeGlobalArticles(
    (article) => {
      try {
        onMaterial(sourceMaterialFromGlobalArticle(article))
      } catch (err) {
        console.error('tc-presenter: failed to convert global article into a source', err)
      }
    },
    (status: GlobalArticlesStatus) => {
      onStatus(status.phase === 'error' ? { phase: 'error', message: status.message } : { phase: status.phase })
    },
  )
}

// Wave2 B owns this feature: the slide renderer (components/slides) + the
// auto-presentation player (PresentPlayer.tsx). This tab component is the
// thin wrapper PLAN.md calls for: it decides *when* to mount
// `<PresentPlayer deck onExit />` (types.ts's `PresentPlayerProps` contract).
//
// `PresentTabProps` has no navigation callback back to app.tsx (the tab
// shell doesn't expose one), so `onExit` is handled locally: leaving
// presentation mode drops back to a small "ready to present" screen with a
// button to re-enter, rather than trying to switch tabs itself.
import { Play } from 'lucide-preact'
import { useEffect, useState } from 'preact/hooks'
import '../../styles/global.css'
import { t } from '../../i18n'
import type { PresentTabProps } from '../../types'
import { CharacterManager } from '../../vrm/CharacterManager'
import { PresentPlayer } from './PresentPlayer'
import './present-tab.css'

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

// Tracks the last `autoStartToken` this tab has already acted on, across
// mounts — PresentTab fully unmounts whenever the user leaves this tab (see
// app.tsx: `{tab === 'present' && <PresentTab .../>}`), so component state/
// refs can't carry this. app.tsx only bumps the token for an explicit
// "Present" action (editor's handlePresent), never for a plain tab switch,
// so comparing against this module-level value is enough to make the
// auto-start one-shot without re-triggering on every remount.
let consumedAutoStartToken = 0

export default function PresentTab({ deck, autoStartToken }: PresentTabProps) {
  const [presenting, setPresenting] = useState(false)

  useEffect(() => {
    const token = autoStartToken ?? 0
    if (deck && token !== 0 && token !== consumedAutoStartToken) {
      consumedAutoStartToken = token
      setPresenting(true)
    }
    // Mount-only: autoStartToken can only change while this component is
    // unmounted (see comment above), so there's nothing to react to later.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!deck) {
    return (
      <>
        <div class="feature-placeholder present-tab__empty">
          <p>
            <strong>{t('present.emptyTitle')}</strong>
          </p>
          <p>{t('present.emptyBody')}</p>
        </div>
        <CharacterManager />
      </>
    )
  }

  if (!presenting) {
    return (
      <>
        <div class="present-tab__ready">
          <div class="present-tab__ready-card">
            <p class="present-tab__ready-title">{deck.title}</p>
            <p class="present-tab__ready-meta">{t('present.deckSlideCount', { count: deck.slides.length })}</p>
            {deck.updatedAt && (
              <p class="present-tab__ready-updated">{t('present.updatedAt', { date: formatDate(deck.updatedAt) })}</p>
            )}
            <button type="button" class="present-tab__start" onClick={() => setPresenting(true)}>
              <Play size={20} />
              {t('present.start')}
            </button>
          </div>
        </div>
        <CharacterManager />
      </>
    )
  }

  return <PresentPlayer deck={deck} onExit={() => setPresenting(false)} />
}

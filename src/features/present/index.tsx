// Wave2 B owns this feature: the slide renderer (components/slides) + the
// auto-presentation player (PresentPlayer.tsx). This tab component is the
// thin wrapper PLAN.md calls for: it decides *when* to mount
// `<PresentPlayer deck onExit />` (types.ts's `PresentPlayerProps` contract).
//
// `PresentTabProps` has no navigation callback back to app.tsx (the tab
// shell doesn't expose one), so `onExit` is handled locally: leaving
// presentation mode drops back to a small "ready to present" screen with a
// button to re-enter, rather than trying to switch tabs itself.
import { useEffect, useState } from 'preact/hooks'
import '../../styles/global.css'
import { t } from '../../i18n'
import type { PresentTabProps } from '../../types'
import { CharacterManager } from '../../vrm/CharacterManager'
import { PresentPlayer } from './PresentPlayer'
import './present-tab.css'

export default function PresentTab({ deck }: PresentTabProps) {
  const [presenting, setPresenting] = useState(Boolean(deck))

  // If a deck first becomes available while this tab is open (e.g. the user
  // just finished generating one in Editor and tabs over), jump straight
  // into presenting — matching the "start immediately" expectation.
  useEffect(() => {
    if (deck && !presenting) setPresenting(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deck])

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
          <p class="present-tab__ready-title">{deck.title}</p>
          <p class="present-tab__ready-meta">{t('present.deckSlideCount', { count: deck.slides.length })}</p>
          <button type="button" class="present-tab__start" onClick={() => setPresenting(true)}>
            {t('present.resume')}
          </button>
        </div>
        <CharacterManager />
      </>
    )
  }

  return <PresentPlayer deck={deck} onExit={() => setPresenting(false)} />
}

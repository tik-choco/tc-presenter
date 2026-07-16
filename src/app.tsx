import { useEffect, useState } from 'preact/hooks'
import { lazy, Suspense } from 'preact/compat'
import { Moon, Sun } from 'lucide-preact'
import { useTheme } from './hooks/useTheme'
import { t } from './i18n'
import GenerateQueueToast from './components/GenerateQueueToast'
import { Onboarding } from './components/Onboarding'
import { loadDeck } from './lib/kv'
import { markOnboardingDone, shouldShowOnboarding, subscribeOnboardingRequests } from './lib/onboarding'
import type {
  Deck,
  SourceMaterial,
  SourcesTabProps,
  EditorTabProps,
  PresentTabProps,
  SettingsTabProps,
} from './types'
import type { ComponentType } from 'preact/compat'

type TabId = 'sources' | 'editor' | 'present' | 'settings'

const TABS: TabId[] = ['sources', 'editor', 'present', 'settings']

function isTabId(value: unknown): value is TabId {
  return typeof value === 'string' && (TABS as string[]).includes(value)
}

// Contract (see types.ts's "App shell / tab contracts" section): each
// features/<name>/index.tsx exports a default Preact component accepting
// the matching *TabProps type. This file only owns the tab shell, lazy
// loading, and the top-level sources/deck state that features read/write
// through those props — Wave2 owners (A: generate, B: present, C: sources/
// editor/settings) implement the actual feature bodies. Until then each
// features/<name>/index.tsx here is a typed placeholder so `tsc --noEmit`
// stays green; replace the file's contents in place, keep the default
// export's prop type identical (or update types.ts first and tell the
// other workers).
const SourcesTab = lazy(() => import('./features/sources')) as ComponentType<SourcesTabProps>
const EditorTab = lazy(() => import('./features/editor')) as ComponentType<EditorTabProps>
const PresentTab = lazy(() => import('./features/present')) as ComponentType<PresentTabProps>
const SettingsTab = lazy(() => import('./features/settings')) as ComponentType<SettingsTabProps>

export function App() {
  const { theme, toggleTheme } = useTheme()
  const [tab, setTab] = useState<TabId>('sources')
  const [sources, setSources] = useState<SourceMaterial[]>([])
  const [deck, setDeck] = useState<Deck | null>(null)
  // Bumped whenever a navigate event asks Present to auto-start (see below);
  // PresentTab uses this as a one-shot token so only that explicit request
  // starts playback immediately, not every visit to the tab.
  const [presentAutoStartToken, setPresentAutoStartToken] = useState(0)

  // First-run wizard: shown once on a fresh install, and re-openable from the
  // settings screen. Closing it (any path) marks onboarding done.
  const [showOnboarding, setShowOnboarding] = useState(() => shouldShowOnboarding())
  useEffect(() => subscribeOnboardingRequests(() => setShowOnboarding(true)), [])

  function closeOnboarding() {
    markOnboardingDone()
    setShowOnboarding(false)
  }

  // Decoupled cross-tab navigation hook: features (e.g. editor's "Present"
  // button) dispatch this instead of taking a prop-based callback, since
  // *TabProps contracts don't expose one. See features/editor/index.tsx's
  // handlePresent for the dispatch side.
  useEffect(() => {
    function handleNavigate(event: Event) {
      const detail = (event as CustomEvent<{ tab?: string; autoStart?: boolean }>).detail
      if (detail && isTabId(detail.tab)) {
        setTab(detail.tab)
        if (detail.autoStart) setPresentAutoStartToken((n) => n + 1)
      }
    }
    window.addEventListener('tc-presenter:navigate', handleNavigate)
    return () => window.removeEventListener('tc-presenter:navigate', handleNavigate)
  }, [])

  // Opens a just-generated deck from the queue toast: loads it from
  // lib/kv.ts (falling back to a no-op if it's since been deleted) and
  // switches to the Editor tab.
  function handleOpenGeneratedDeck(deckId: string) {
    const loaded = loadDeck(deckId)
    if (loaded) {
      setDeck(loaded)
      setTab('editor')
    }
  }

  return (
    <div class="app-shell">
      <header class="app-header">
        <h1 class="app-title">{t('app.title')}</h1>
        <nav class="tab-bar" aria-label="Main">
          {TABS.map((id) => (
            <button
              key={id}
              type="button"
              class={`tab-bar__item${tab === id ? ' is-active' : ''}`}
              onClick={() => setTab(id)}
              aria-current={tab === id ? 'page' : undefined}
            >
              {t(`tabs.${id}`)}
            </button>
          ))}
        </nav>
        <button
          type="button"
          class="theme-toggle"
          onClick={toggleTheme}
          title={t('theme.toggle')}
          aria-label={t('theme.toggle')}
        >
          {theme === 'dark' ? <Sun size={20} /> : <Moon size={20} />}
        </button>
      </header>

      <main class="app-main">
        <Suspense fallback={<div class="app-loading">{t('common.loading')}</div>}>
          {tab === 'sources' && <SourcesTab sources={sources} onSourcesChange={setSources} />}
          {tab === 'editor' && <EditorTab deck={deck} onDeckChange={setDeck} sources={sources} />}
          {tab === 'present' && <PresentTab deck={deck} autoStartToken={presentAutoStartToken} />}
          {tab === 'settings' && <SettingsTab />}
        </Suspense>
      </main>

      <GenerateQueueToast onOpenDeck={handleOpenGeneratedDeck} />
      {showOnboarding && <Onboarding onClose={closeOnboarding} />}
    </div>
  )
}

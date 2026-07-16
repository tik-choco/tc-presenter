import { render } from 'preact'
import { lazy, Suspense } from 'preact/compat'
import './styles/tokens.css'
import './styles/global.css'
import { App } from './app.tsx'
import { isStageWindow } from './features/present/stageSync'
import { writeAppManifest } from './lib/appManifest'
import { BUS_VERSION } from './lib/sharedBus'

// The stage window (`?window=stage`) is a separate, unrelated-family popup
// (see features/present/stageSync.ts) — lazy so its chunk (and SlideView/
// vrm deps) never loads as part of the normal app-shell bundle.
const StageWindow = lazy(() => import('./features/present/StageWindow'))

if (isStageWindow()) {
  render(
    <Suspense fallback={null}>
      <StageWindow />
    </Suspense>,
    document.getElementById('app')!,
  )
} else {
  render(<App />, document.getElementById('app')!)

  // The stage window doesn't advertise itself to the app family — it's a
  // private renderer for one presenter window, not a participant in
  // lib/sharedBus.ts's cross-app contract.
  writeAppManifest({
    app: 'tc-presenter',
    busVersion: BUS_VERSION,
    publishes: [],
    // Subscribes to tc-news's/tc-note's `note-article` topic (see
    // features/sources/newsArticleAdapter.ts) and tc-note's `note-doc-index`
    // topic (see lib/noteDocIndex.ts) to ingest articles/notes as
    // SourceMaterial (see PLAN.md's "news連携" and lib/sharedBus.ts).
    consumes: ['note-article', 'note-doc-index'],
    reads: [],
  })
}

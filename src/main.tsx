import { render } from 'preact'
import './styles/tokens.css'
import './styles/global.css'
import { App } from './app.tsx'
import { writeAppManifest } from './lib/appManifest'
import { BUS_VERSION } from './lib/sharedBus'

render(<App />, document.getElementById('app')!)

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

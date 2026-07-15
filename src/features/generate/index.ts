// Pure re-export barrel for the generation pipeline. The editor tab
// (features/editor/index.tsx) imports `generateDeck`/`evaluateDeck` from
// '../generate' — this file exists only to keep that import path working.
//
// There used to be a thin, unused `GeneratePanel` default export here (a
// self-contained generate form). It was dead code: the editor tab has its
// own inline generation form and never imported it. Removed; see
// generateDeck.ts / prompts.ts / parse.ts / theme.ts for the actual
// generation pipeline modules, which are still used directly by the editor.
export { generateDeck } from './generateDeck'
export { evaluateDeck } from '../../lib/evaluator'

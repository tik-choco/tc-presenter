// Default DeckTheme for freshly generated decks. Matches styles/tokens.css's
// light-mode --primary/--secondary/--danger/--neutral-gray/--text values
// exactly (see that file's header comment: "also used as Deck.theme's
// default") — every generated deck defaults to the same wine-red/navy
// palette the app chrome itself uses, per notes-slide-quality.md §5's
// colorPalette proposal.
import type { DeckTheme } from '../../types'

export const DEFAULT_DECK_THEME: DeckTheme = {
  colorPalette: {
    primary: '#7a2048',
    secondary: '#1a3a5c',
    accentWarning: '#c0392b',
    neutralGray: '#9aa0a6',
    background: '#ffffff',
    textPrimary: '#2c1f26',
  },
  aspectRatio: '16:9',
  fontFamily:
    'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
}

// A small set of selectable DeckTheme presets for the "new deck" creation
// form (PLAN.md / the task brief's "テーマ" option). GenerateOptions
// (types.ts) has no theme field of its own — generateDeck always returns
// DEFAULT_DECK_THEME (features/generate/theme.ts) — so a non-default choice
// here is applied client-side by overwriting the generated Deck.theme before
// it's saved, matching this app's plain-CSS custom-property palette model
// (DeckThemeColorPalette in types.ts).
import type { DeckTheme } from '../../types'
import { DEFAULT_DECK_THEME } from '../generate/theme'

export interface DeckThemePreset {
  id: string
  label: string
  theme: DeckTheme
}

const OCEAN_THEME: DeckTheme = {
  colorPalette: {
    primary: '#0f6e8c',
    secondary: '#123a5c',
    accentWarning: '#c0392b',
    neutralGray: '#9aa6ad',
    background: '#ffffff',
    textPrimary: '#132a33',
  },
  aspectRatio: '16:9',
  fontFamily: DEFAULT_DECK_THEME.fontFamily,
}

const FOREST_THEME: DeckTheme = {
  colorPalette: {
    primary: '#2f6a3f',
    secondary: '#5c4a1a',
    accentWarning: '#c0392b',
    neutralGray: '#9aa08f',
    background: '#ffffff',
    textPrimary: '#20291f',
  },
  aspectRatio: '16:9',
  fontFamily: DEFAULT_DECK_THEME.fontFamily,
}

export const DECK_THEME_PRESETS: DeckThemePreset[] = [
  { id: 'default', label: 'Wine & Navy', theme: DEFAULT_DECK_THEME },
  { id: 'ocean', label: 'Ocean', theme: OCEAN_THEME },
  { id: 'forest', label: 'Forest', theme: FOREST_THEME },
]

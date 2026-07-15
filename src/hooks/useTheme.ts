import { useCallback, useEffect, useState } from 'preact/hooks'

export type Theme = 'light' | 'dark'

const STORAGE_KEY = 'tc-presenter-theme'
const THEME_COLORS: Record<Theme, string> = { light: '#ffffff', dark: '#120c10' }

export function getStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'dark' || stored === 'light') return stored
  } catch {
    // localStorage unavailable (private mode etc.)
  }
  return 'light'
}

export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', THEME_COLORS[theme])
}

/**
 * Light/dark theme with localStorage persistence. Light is the default.
 * The initial theme is also applied by an inline script in index.html to
 * avoid a flash of the wrong theme before the app mounts; this hook keeps
 * the document, storage and UI in sync afterwards.
 */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(getStoredTheme)

  useEffect(() => {
    applyTheme(theme)
    try {
      localStorage.setItem(STORAGE_KEY, theme)
    } catch {
      // ignore persistence failures
    }
  }, [theme])

  const toggleTheme = useCallback(() => {
    setTheme((current) => (current === 'dark' ? 'light' : 'dark'))
  }, [])

  return { theme, toggleTheme }
}

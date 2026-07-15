// Presenter-character display settings: whether it's shown at all, which
// side of the slide it stands on, how big it renders, and which imported VRM
// it points at. Persisted to localStorage (mirrors PresentPlayer.tsx's
// fallback-cps setting: a small parse-guarded JSON blob under one key).
//
// No three.js dependency here — safe to import statically from both
// CharacterManager.tsx (PresentTab, no three.js) and PresentPlayer.tsx
// (which only loads three.js via the separately-chunked PresenterCharacter.tsx).
import type { VrmAvatarRef } from './types'

export type PresenterPosition = 'left' | 'right'
export type PresenterSize = 'small' | 'medium' | 'large'

export interface PresenterCharacterSettings {
  enabled: boolean
  position: PresenterPosition
  size: PresenterSize
  selected: VrmAvatarRef | null
}

const STORAGE_KEY = 'tc-presenter-presenter-character-v1'

const DEFAULTS: PresenterCharacterSettings = { enabled: false, position: 'right', size: 'medium', selected: null }

function isPosition(value: unknown): value is PresenterPosition {
  return value === 'left' || value === 'right'
}

function isSize(value: unknown): value is PresenterSize {
  return value === 'small' || value === 'medium' || value === 'large'
}

function isVrmAvatarRef(value: unknown): value is VrmAvatarRef {
  if (!value || typeof value !== 'object') return false
  const ref = value as Record<string, unknown>
  return typeof ref.blobKey === 'string' && typeof ref.checksum === 'string' && typeof ref.fileName === 'string'
}

export function loadPresenterCharacterSettings(): PresenterCharacterSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULTS
    const parsed = JSON.parse(raw) as Partial<PresenterCharacterSettings>
    return {
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : DEFAULTS.enabled,
      position: isPosition(parsed.position) ? parsed.position : DEFAULTS.position,
      size: isSize(parsed.size) ? parsed.size : DEFAULTS.size,
      selected: isVrmAvatarRef(parsed.selected) ? parsed.selected : null,
    }
  } catch {
    return DEFAULTS
  }
}

export function savePresenterCharacterSettings(settings: PresenterCharacterSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // best-effort persistence only
  }
}

// Presenter-character management UI, mounted in PresentTab's pre-presentation
// screens (features/present/index.tsx): import/select/delete .vrm files from
// the shared tc-vrm-viewer/models IndexedDB library (vrm/library.ts) and
// configure how the presenter avatar appears during playback
// (vrm/characterSettings.ts).
//
// This module itself only imports vrm/library.ts and vrm/characterSettings.ts
// (no three.js). The live preview below is the one exception: it renders via
// PresenterCharacter, loaded the same way PresentPlayer.tsx loads it —
// `lazy(() => import('../vrm/PresenterCharacter'))` — so three.js's chunk
// only fetches once the "Show presenter character" toggle is actually on,
// not just from opening this tab.
import { useEffect, useRef, useState } from 'preact/hooks'
import { lazy, Suspense } from 'preact/compat'
import type { ComponentType } from 'preact/compat'
import { Trash2 } from 'lucide-preact'
import { t } from '../i18n'
import { deleteVrmModel, importVrmFile, listVrmModels, type VrmModelInfo } from './library'
import {
  loadPresenterCharacterSettings,
  savePresenterCharacterSettings,
  type PresenterCharacterSettings,
  type PresenterPosition,
  type PresenterSize,
} from './characterSettings'
import type { PresenterCharacterProps } from './PresenterCharacter'
import './character-manager.css'

const PresenterCharacter = lazy(() => import('./PresenterCharacter')) as ComponentType<PresenterCharacterProps>

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function CharacterManager() {
  const [models, setModels] = useState<VrmModelInfo[]>([])
  const [settings, setSettings] = useState<PresenterCharacterSettings>(() => loadPresenterCharacterSettings())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const refresh = () => {
    listVrmModels()
      .then(setModels)
      .catch(() => setModels([]))
  }

  useEffect(refresh, [])

  const update = (patch: Partial<PresenterCharacterSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch }
      savePresenterCharacterSettings(next)
      return next
    })
  }

  const handleImport = async (e: Event) => {
    const input = e.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      const model = await importVrmFile(file)
      refresh()
      update({ selected: { blobKey: model.id, checksum: model.checksum, fileName: model.name } })
    } catch {
      setError(t('present.character.importError'))
    } finally {
      setBusy(false)
    }
  }

  const handleSelect = (model: VrmModelInfo) => {
    update({ selected: { blobKey: model.id, checksum: model.checksum, fileName: model.name } })
  }

  const handleDelete = async (model: VrmModelInfo) => {
    setBusy(true)
    try {
      await deleteVrmModel(model.id)
      refresh()
      if (settings.selected?.blobKey === model.id) update({ selected: null })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section class="character-manager">
      <h3 class="character-manager__title">{t('present.character.title')}</h3>
      <p class="character-manager__hint">{t('present.character.hint')}</p>

      <label class="character-manager__toggle">
        <input
          type="checkbox"
          checked={settings.enabled}
          onChange={(e) => update({ enabled: (e.currentTarget as HTMLInputElement).checked })}
        />
        {t('present.character.enable')}
      </label>

      <div class="character-manager__row">
        <label class="character-manager__field">
          {t('present.character.position')}
          <select
            value={settings.position}
            onChange={(e) => update({ position: (e.currentTarget as HTMLSelectElement).value as PresenterPosition })}
          >
            <option value="left">{t('present.character.positionLeft')}</option>
            <option value="right">{t('present.character.positionRight')}</option>
          </select>
        </label>
        <label class="character-manager__field">
          {t('present.character.size')}
          <select
            value={settings.size}
            onChange={(e) => update({ size: (e.currentTarget as HTMLSelectElement).value as PresenterSize })}
          >
            <option value="small">{t('present.character.sizeSmall')}</option>
            <option value="medium">{t('present.character.sizeMedium')}</option>
            <option value="large">{t('present.character.sizeLarge')}</option>
          </select>
        </label>
      </div>

      {settings.enabled && settings.selected && (
        <div class="character-manager__preview">
          <Suspense fallback={null}>
            <PresenterCharacter vrmRef={settings.selected} speaking={false} framing="upper" />
          </Suspense>
        </div>
      )}

      <div class="character-manager__row">
        <button
          type="button"
          class="character-manager__btn character-manager__btn--primary"
          onClick={() => fileInputRef.current?.click()}
          disabled={busy}
        >
          {t('present.character.import')}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".vrm"
          class="character-manager__hidden-input"
          onChange={handleImport}
        />
      </div>
      {error && <p class="character-manager__error">{error}</p>}

      {models.length === 0 ? (
        <p class="character-manager__empty">{t('present.character.empty')}</p>
      ) : (
        <ul class="character-manager__list">
          {models.map((model) => (
            <li key={model.id} class="character-manager__item">
              <button
                type="button"
                class={`character-manager__item-select${
                  settings.selected?.blobKey === model.id ? ' character-manager__item-select--active' : ''
                }`}
                onClick={() => handleSelect(model)}
              >
                <span class="character-manager__item-name">{model.name}</span>
                <span class="character-manager__item-size">{formatSize(model.size)}</span>
              </button>
              <button
                type="button"
                class="character-manager__item-remove"
                onClick={() => handleDelete(model)}
                aria-label={t('present.character.remove')}
                disabled={busy}
              >
                <Trash2 size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export default CharacterManager

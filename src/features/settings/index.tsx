// Wave2 C owns this feature: LLM/TTS provider + preset management (against
// the shared tc-shared-llm-config-v1 config, see lib/llmConfig.ts) and AI
// Network room/status toggles (lib/aiNetwork.ts), plus theme/locale.
//
// Contract (types.ts): default-export a Preact component accepting
// `SettingsTabProps` (currently empty — this tab manages its own state
// directly against lib/llmConfig.ts rather than through app.tsx).
//
// UI shape follows tc-docs/drafts/llm-settings-common-v1.md (ported from
// tc-translate's SettingsModal): three tabs — AI接続 (provider/preset flat
// card grids, append-only), AI Network (Room ID + consumer/provider role
// cards), タスク (one row per generation task + TTS, label tooltips instead
// of always-visible hint paragraphs). Locale + onboarding replay stay
// outside the tabs (always visible, like tc-translate's language row above
// its tab bar).
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { Network, Play, Plus, RefreshCw, Server, Sparkles } from 'lucide-preact'
import { MESSAGES_EN, MESSAGES_JA, type LlmCallFn, type SynthesizeFn } from '@tik-choco/mistai'
import { ConsumerStatusIndicator, ProviderStatusPanel, useConsumerConnection, useConsumerStatus } from '@tik-choco/mistai/preact'
import '@tik-choco/mistai/ui.css'
import './settings.css'
import { getLocale, setLocale, subscribeLocale, t, type Locale } from '../../i18n'
import { useModelOptions, type ModelFetchStatus } from '../../lib/models'
import { OPENAI_TTS_VOICES, useVoiceOptions } from '../../lib/voices'
import {
  emptyLlmConfig,
  ensurePreset,
  ensureProvider,
  loadLlmConfig,
  normalizeBaseUrl,
  resolvePreset,
  resolveVoice,
  saveLlmConfig,
  subscribeLlmConfig,
  type LlmProviderV1,
  type ModelPresetV1,
  type ResolvedLlmTargetV1,
  type SharedLlmConfigV1,
  type VoiceConfigV1,
} from '../../lib/llmConfig'
import { advertisedModelName, isNetworkProviderBaseUrl, NETWORK_VOICE_AUTO_MODEL } from '../../lib/networkModels'
import { createMistNode, networkClient, NODE_ID_STORAGE_KEY, useNetworkProvider } from '../../lib/aiNetwork'
import { requestApiChatCompletionStreaming } from '../../lib/llm'
import { requestOnboarding } from '../../lib/onboarding'
import { synthesizeSpeech } from '../../lib/tts'
import type { SettingsTabProps } from '../../types'
import {
  clampWorkerConcurrency,
  loadGenerateRolePrefs,
  loadNetworkEnabled,
  loadNetworkProviderEnabled,
  loadNetworkProviderPresetIds,
  loadVisionPresetId,
  saveGenerateRolePrefs,
  saveNetworkEnabled,
  saveNetworkProviderEnabled,
  saveNetworkProviderPresetIds,
  saveVisionPresetId,
  type GenerateRolePrefs,
} from './localPrefs'

const OLLAMA_BASE_URL = 'http://localhost:11434/v1'
const LM_STUDIO_BASE_URL = 'http://localhost:1234/v1'

/** 新規プリセット作成時の既定 reasoning_effort — 思考なしで応答を速くするため "none"。
 * 空文字にすればパラメータ自体を送らない従来の挙動に戻せる(lib/llm.ts の apiConfig 参照)。 */
const DEFAULT_REASONING_EFFORT = 'none'

/** reasoning_effort の選択肢(tc-docs/llm-settings-common-v1.md §3.1 の共通並び)。
 * 空文字(=パラメータを送らない)は選択肢とは別に「未指定」optionとして出す。 */
const REASONING_EFFORT_OPTIONS = ['none', 'minimal', 'low', 'medium', 'high'] as const

function cloneConfig(config: SharedLlmConfigV1): SharedLlmConfigV1 {
  return { ...config, providers: [...config.providers], presets: [...config.presets], network: { ...config.network } }
}

function providerLabelFor(config: SharedLlmConfigV1, providerId: string): string {
  const provider = config.providers.find((p) => p.id === providerId)
  if (!provider) return t('settings.llm.unknownConnection')
  return provider.label || provider.baseUrl
}

function hostLabelFor(baseUrl: string): string {
  try {
    return new URL(baseUrl).host || baseUrl
  } catch {
    return baseUrl
  }
}

// ---------------------------------------------------------------------------
// Model/voice pickers (fetch from the provider's /models or voices endpoint,
// with a manual-entry fallback for offline use or endpoints that can't list
// options). Ported from tc-news's src/views/SettingsView.tsx. useModelOptions/
// useVoiceOptions (lib/models.ts) already skip the fetch for a
// `mist-network://` baseUrl (llm-settings-common-v1.md §5.3 checklist #2).

/** Dedupes `options` against the current `value` (so a manually-typed or
 * stale value stays selectable) and sorts for a stable <select> order. Shared
 * by ModelField and VoiceField. */
function mergeOptions(value: string, options: string[]): string[] {
  const merged = value.trim() ? [value, ...options] : options
  return [...new Set(merged)].sort((a, b) => a.localeCompare(b))
}

interface SelectWithFallbackProps {
  id: string
  value: string
  options: string[]
  status: ModelFetchStatus
  statusText: string
  canFetch: boolean
  refresh: () => void
  onChange: (value: string) => void
  manualPlaceholder: string
  refreshTitle: string
  unselectedLabel: string
}

/** Shared select + refresh + manual-entry widget behind ModelField and
 * VoiceField: a <select> populated from a fetch hook, a refresh button, and
 * a manual-entry toggle for endpoints that can't list options (or when
 * there's no network access at all — fetch failures never block editing). */
function SelectWithFallback(props: SelectWithFallbackProps) {
  const {
    id,
    value,
    options,
    status,
    statusText,
    canFetch,
    refresh,
    onChange,
    manualPlaceholder,
    refreshTitle,
    unselectedLabel,
  } = props
  const [manualEntry, setManualEntry] = useState(false)

  return (
    <div class="set-model-field">
      {manualEntry ? (
        <input
          id={id}
          type="text"
          value={value}
          placeholder={manualPlaceholder}
          onInput={(e) => onChange(e.currentTarget.value)}
        />
      ) : (
        <div class="set-model-field__row">
          <select id={id} value={value} onChange={(e) => onChange(e.currentTarget.value)}>
            {value.trim() === '' ? <option value="">{unselectedLabel}</option> : null}
            {options.map((option) => (
              <option value={option} key={option}>
                {option}
              </option>
            ))}
          </select>
          <button
            type="button"
            class="set-icon-btn"
            onClick={refresh}
            disabled={status === 'loading' || !canFetch}
            title={refreshTitle}
            aria-label={refreshTitle}
          >
            <RefreshCw size={14} class={status === 'loading' ? 'set-icon-spin' : ''} />
          </button>
        </div>
      )}
      <div class="set-model-field__footer">
        <span class="set-model-field__status">{statusText}</span>
        <button type="button" class="set-link-btn" onClick={() => setManualEntry((prev) => !prev)}>
          {manualEntry ? t('common.selectFromList') : t('common.manualInput')}
        </button>
      </div>
    </div>
  )
}

/** Model picker: a <select> populated from useModelOptions(baseUrl, apiKey),
 * a refresh button, and a manual-entry fallback for endpoints that can't
 * list models. Shared by the LLM preset card's model field and the TTS
 * task row's voice field. */
function ModelField(props: { id: string; value: string; baseUrl: string; apiKey: string; onChange: (model: string) => void }) {
  const { id, value, baseUrl, apiKey, onChange } = props
  const { options, status, errorMessage, refresh } = useModelOptions(baseUrl, apiKey)

  const selectableOptions = mergeOptions(value, options)
  const canFetch = baseUrl.trim().length > 0 && !isNetworkProviderBaseUrl(baseUrl)
  const statusText =
    status === 'loading'
      ? t('common.loading')
      : status === 'error'
        ? errorMessage || t('settings.llm.modelListErrorFallback')
        : status === 'done'
          ? t('settings.llm.modelListFetched', { count: options.length })
          : ''

  return (
    <SelectWithFallback
      id={id}
      value={value}
      options={selectableOptions}
      status={status}
      statusText={statusText}
      canFetch={canFetch}
      refresh={refresh}
      onChange={onChange}
      manualPlaceholder="gpt-4o-mini"
      refreshTitle={t('settings.llm.refreshModels')}
      unselectedLabel={t('common.unselected')}
    />
  )
}

/** Voice picker: mirrors ModelField's UX but sources options from
 * useVoiceOptions(baseUrl, apiKey). Most OpenAI-compatible TTS endpoints
 * don't expose a voices-listing endpoint, so when the fetch comes back empty
 * (mistai's `fetchVoices` resolves `[]` rather than rejecting in that case —
 * see lib/voices.ts) we fall back to OPENAI_TTS_VOICES (the standard OpenAI
 * voice set) instead of leaving the select empty. The `status === 'error'`
 * branches stay as a defensive fallback for the (now unreachable via
 * fetchVoices) hook-level rejection path. */
function VoiceField(props: { id: string; value: string; baseUrl: string; apiKey: string; onChange: (voice: string) => void }) {
  const { id, value, baseUrl, apiKey, onChange } = props
  const { options, status, refresh } = useVoiceOptions(baseUrl, apiKey)

  const fetchedOrFallback = options.length > 0 ? options : OPENAI_TTS_VOICES
  const selectableOptions = mergeOptions(value, fetchedOrFallback)
  const canFetch = baseUrl.trim().length > 0 && !isNetworkProviderBaseUrl(baseUrl)
  const statusText =
    status === 'loading'
      ? t('common.loading')
      : status === 'error'
        ? t('settings.tts.voiceListErrorFallback')
        : status === 'done'
          ? options.length > 0
            ? t('settings.tts.voiceListFetched', { count: options.length })
            : t('settings.tts.voiceListErrorFallback')
          : ''

  return (
    <SelectWithFallback
      id={id}
      value={value}
      options={selectableOptions}
      status={status}
      statusText={statusText}
      canFetch={canFetch}
      refresh={refresh}
      onChange={onChange}
      manualPlaceholder="alloy"
      refreshTitle={t('settings.tts.refreshVoices')}
      unselectedLabel={t('common.unselected')}
    />
  )
}

// ---------------------------------------------------------------------------
// AI接続 tab: flat provider/preset card grids (llm-settings-common-v1.md
// §3.1). Append-only — lib/llmConfig.ts intentionally has no
// removeProvider/removePreset (see its header comment: "entries can't be
// deleted so other apps' configuration is never lost"), so unlike
// tc-translate's reference UI these cards have no delete affordance, only
// in-place edit. Edits commit per-field on blur (label/baseUrl/apiKey,
// temperature, reasoningEffort) or immediately on select (provider, model),
// matching §3.1's "blur でコミット、モデルselectの選択=コミットで行クローズ".

interface ConnectionTabProps {
  config: SharedLlmConfigV1
  onChange: (config: SharedLlmConfigV1) => void
}

function ConnectionTab({ config, onChange }: ConnectionTabProps) {
  const [editingProviderId, setEditingProviderId] = useState('')
  const [addingProvider, setAddingProvider] = useState(false)
  const [npLabel, setNpLabel] = useState('')
  const [npBaseUrl, setNpBaseUrl] = useState('')
  const [npApiKey, setNpApiKey] = useState('')

  const [editingPresetId, setEditingPresetId] = useState('')
  const [epModel, setEpModel] = useState('')

  const [addingPreset, setAddingPreset] = useState(false)
  const [apLabel, setApLabel] = useState('')
  const [apProviderId, setApProviderId] = useState('')
  const [apModel, setApModel] = useState('')

  const activeRowRef = useRef<HTMLDivElement | null>(null)

  function closeAllInlineRows(): void {
    setEditingProviderId('')
    setAddingProvider(false)
    setEditingPresetId('')
    setAddingPreset(false)
  }

  useEffect(() => {
    if (editingProviderId && !config.providers.some((p) => p.id === editingProviderId)) setEditingProviderId('')
    if (editingPresetId && !config.presets.some((p) => p.id === editingPresetId)) setEditingPresetId('')
  }, [config.providers, config.presets])

  const mouseDownInside = useRef(false)
  useEffect(() => {
    if (!editingProviderId && !addingProvider && !editingPresetId && !addingPreset) return undefined

    function handleDown(event: MouseEvent): void {
      mouseDownInside.current = Boolean(activeRowRef.current && activeRowRef.current.contains(event.target as Node))
    }
    function handleClick(event: MouseEvent): void {
      if (activeRowRef.current && activeRowRef.current.contains(event.target as Node)) return
      if (mouseDownInside.current) return
      closeAllInlineRows()
    }
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') closeAllInlineRows()
    }

    document.addEventListener('mousedown', handleDown)
    document.addEventListener('click', handleClick)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleDown)
      document.removeEventListener('click', handleClick)
      document.removeEventListener('keydown', handleKeyDown)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingProviderId, addingProvider, editingPresetId, addingPreset])

  // --- 接続先 (provider) handlers ------------------------------------------

  function handleOpenEditProvider(provider: LlmProviderV1): void {
    closeAllInlineRows()
    setEditingProviderId(provider.id)
  }

  function commitProviderField(provider: LlmProviderV1, field: 'label' | 'baseUrl' | 'apiKey', value: string): void {
    if (field === 'baseUrl' && !value.trim()) return
    const normalized = field === 'baseUrl' ? normalizeBaseUrl(value) : value
    if (normalized === provider[field]) return
    const next = cloneConfig(config)
    next.providers = next.providers.map((p) => (p.id === provider.id ? { ...p, [field]: normalized } : p))
    saveLlmConfig(next)
    onChange(next)
  }

  function handleOpenAddProvider(): void {
    closeAllInlineRows()
    setAddingProvider(true)
    setNpLabel('')
    setNpBaseUrl('')
    setNpApiKey('')
  }

  function quickFill(kind: 'ollama' | 'lmstudio'): void {
    if (kind === 'ollama') {
      setNpBaseUrl(OLLAMA_BASE_URL)
      setNpLabel(t('settings.llm.presetFillOllama'))
    } else {
      setNpBaseUrl(LM_STUDIO_BASE_URL)
      setNpLabel(t('settings.llm.presetFillLmStudio'))
    }
  }

  function handleSaveNewProvider(): void {
    const baseUrl = npBaseUrl.trim().replace(/\/+$/, '')
    if (!baseUrl) return
    const next = cloneConfig(config)
    ensureProvider(next, { label: npLabel.trim() || undefined, baseUrl, apiKey: npApiKey })
    saveLlmConfig(next)
    onChange(next)
    setAddingProvider(false)
  }

  // --- モデル (preset) handlers ----------------------------------------------

  function handleOpenEditPreset(preset: ModelPresetV1): void {
    closeAllInlineRows()
    setEditingPresetId(preset.id)
    setEpModel(preset.model)
  }

  function updatePreset(id: string, mutate: (preset: ModelPresetV1) => ModelPresetV1): void {
    const next = cloneConfig(config)
    next.presets = next.presets.map((p) => (p.id === id ? mutate(p) : p))
    saveLlmConfig(next)
    onChange(next)
  }

  function handleEpLabelBlur(preset: ModelPresetV1, value: string): void {
    const label = value.trim() || preset.model
    if (label === preset.label) return
    updatePreset(preset.id, (p) => ({ ...p, label }))
  }

  // Switching providers commits immediately but leaves the stored model
  // untouched until a new one is picked (a model id from the old provider is
  // meaningless in the new provider's list) — only the local draft resets.
  function handleEpProviderChange(preset: ModelPresetV1, providerId: string): void {
    setEpModel('')
    updatePreset(preset.id, (p) => ({ ...p, providerId }))
  }

  function commitEpModel(preset: ModelPresetV1, model: string): void {
    const trimmed = model.trim()
    if (!trimmed) return
    updatePreset(preset.id, (p) => ({ ...p, model: trimmed }))
    setEditingPresetId('')
  }

  function handleEpTemperatureBlur(preset: ModelPresetV1, value: string): void {
    const trimmed = value.trim()
    updatePreset(preset.id, (p) => {
      const updated = { ...p }
      if (!trimmed) {
        delete updated.temperature
        return updated
      }
      const parsed = Number(trimmed)
      if (Number.isFinite(parsed)) updated.temperature = parsed
      return updated
    })
  }

  function handleEpReasoningChange(preset: ModelPresetV1, value: string): void {
    updatePreset(preset.id, (p) => {
      const updated = { ...p }
      if (!value) delete updated.reasoningEffort
      else updated.reasoningEffort = value
      return updated
    })
  }

  function handleOpenAddPreset(): void {
    closeAllInlineRows()
    setAddingPreset(true)
    setApLabel('')
    setApProviderId('')
    setApModel('')
  }

  function handleApProviderChange(providerId: string): void {
    setApProviderId(providerId)
    setApModel('')
  }

  function handleSaveAddPreset(modelOverride?: string): void {
    const model = (modelOverride ?? apModel).trim()
    if (!apProviderId || !model) return
    const next = cloneConfig(config)
    ensurePreset(next, {
      label: apLabel.trim() || undefined,
      providerId: apProviderId,
      model,
      reasoningEffort: DEFAULT_REASONING_EFFORT,
    })
    saveLlmConfig(next)
    onChange(next)
    setAddingPreset(false)
  }

  // --- badges ----------------------------------------------------------------

  function getPresetBadges(preset: ModelPresetV1): string[] {
    const badges: string[] = []
    if (config.defaultPresetId === preset.id) badges.push(t('settings.llm.badgeDefault'))
    if (loadVisionPresetId() === preset.id) badges.push(t('settings.llm.badgeVision'))
    const rolePrefs = loadGenerateRolePrefs()
    if (rolePrefs.orchestratorPresetId === preset.id) badges.push(t('settings.tasks.badgePlan'))
    if (rolePrefs.workerPresetId === preset.id) badges.push(t('settings.tasks.badgeSlides'))
    if (config.tts && config.tts.providerId === preset.providerId && config.tts.model === preset.model) {
      badges.push(t('settings.llm.badgeTts'))
    }
    const provider = config.providers.find((p) => p.id === preset.providerId)
    if (provider && isNetworkProviderBaseUrl(provider.baseUrl)) badges.push(t('settings.llm.badgeNetwork'))
    if (loadNetworkProviderPresetIds().includes(preset.id)) badges.push(t('settings.llm.badgeShared'))
    return badges
  }

  // --- provider row rendering -------------------------------------------------

  function renderProviderRow(provider: LlmProviderV1) {
    const isEditing = editingProviderId === provider.id
    const isNetwork = isNetworkProviderBaseUrl(provider.baseUrl)
    const hostLabel = hostLabelFor(provider.baseUrl)
    const secondLine = isNetwork ? t('settings.llm.connectionNetworkNote') : hostLabel

    if (isEditing) {
      return (
        <div class="model-row model-row-editing" key={provider.id} ref={activeRowRef}>
          <div class="model-row-edit-fields">
            <input
              defaultValue={provider.label}
              onBlur={(e) => commitProviderField(provider, 'label', e.currentTarget.value)}
              onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
              placeholder={t('settings.llm.providerLabel')}
              autoComplete="off"
            />
            <input
              defaultValue={provider.baseUrl}
              title={provider.baseUrl}
              onBlur={(e) => commitProviderField(provider, 'baseUrl', e.currentTarget.value)}
              onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
              placeholder="https://..."
              autoComplete="off"
            />
            <input
              type="password"
              defaultValue={provider.apiKey || ''}
              onBlur={(e) => commitProviderField(provider, 'apiKey', e.currentTarget.value)}
              onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
              placeholder={t('settings.llm.apiKey')}
              autoComplete="off"
            />
          </div>
        </div>
      )
    }

    return (
      <div class={`model-row${isNetwork ? ' model-row-network' : ''}`} key={provider.id}>
        <button type="button" class="model-row-main" onClick={() => handleOpenEditProvider(provider)}>
          <span class="model-row-label">{provider.label || hostLabel}</span>
          <span class="model-row-model">{secondLine}</span>
        </button>
      </div>
    )
  }

  function renderAddProviderTile() {
    if (addingProvider) {
      return (
        <div class="model-row model-row-editing model-row-add" ref={activeRowRef}>
          <div class="model-row-edit-fields">
            <div class="set-quickfill">
              <button type="button" class="connection-form-btn" onClick={() => quickFill('ollama')}>
                {t('settings.llm.presetFillOllama')}
              </button>
              <button type="button" class="connection-form-btn" onClick={() => quickFill('lmstudio')}>
                {t('settings.llm.presetFillLmStudio')}
              </button>
            </div>
            <input value={npLabel} onInput={(e) => setNpLabel(e.currentTarget.value)} placeholder={t('settings.llm.providerLabel')} autoComplete="off" />
            <input value={npBaseUrl} onInput={(e) => setNpBaseUrl(e.currentTarget.value)} placeholder="https://..." autoComplete="off" />
            <input
              type="password"
              value={npApiKey}
              onInput={(e) => setNpApiKey(e.currentTarget.value)}
              placeholder={t('settings.llm.apiKey')}
              autoComplete="off"
            />
          </div>
          <div class="model-row-add-actions">
            <button type="button" class="connection-form-btn connection-form-btn-primary" onClick={handleSaveNewProvider} disabled={!npBaseUrl.trim()}>
              <Plus size={13} />
              {t('settings.llm.addProvider')}
            </button>
            <button type="button" class="connection-form-btn" onClick={() => setAddingProvider(false)}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )
    }
    return (
      <button type="button" class="grid-add-tile" onClick={handleOpenAddProvider}>
        <Plus size={16} />
        <span>{t('settings.llm.addProvider')}</span>
      </button>
    )
  }

  // --- preset row rendering ---------------------------------------------------

  function renderModelRow(preset: ModelPresetV1) {
    const isEditing = editingPresetId === preset.id

    if (isEditing) {
      const provider = config.providers.find((p) => p.id === preset.providerId)
      const isNetworkPreset = provider ? isNetworkProviderBaseUrl(provider.baseUrl) : false
      return (
        <div class="model-row model-row-editing" key={preset.id} ref={activeRowRef}>
          <div class="model-row-edit-fields">
            <input
              defaultValue={preset.label}
              onBlur={(e) => handleEpLabelBlur(preset, e.currentTarget.value)}
              onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
              placeholder={t('settings.llm.presetLabel')}
              autoComplete="off"
            />
            <select value={preset.providerId} onChange={(e) => handleEpProviderChange(preset, e.currentTarget.value)}>
              {config.providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label || hostLabelFor(p.baseUrl)}
                </option>
              ))}
            </select>
            <div class="connection-form-model-field">
              {isNetworkPreset ? (
                <input value={epModel} disabled title={t('settings.llm.connectionNetworkNote')} />
              ) : (
                <ModelField
                  id={`set-preset-model-${preset.id}`}
                  value={epModel}
                  baseUrl={provider?.baseUrl ?? ''}
                  apiKey={provider?.apiKey ?? ''}
                  onChange={(value) => {
                    setEpModel(value)
                    commitEpModel(preset, value)
                  }}
                />
              )}
            </div>
            <input
              type="number"
              min="0"
              max="2"
              step="0.1"
              defaultValue={preset.temperature ?? ''}
              onBlur={(e) => handleEpTemperatureBlur(preset, e.currentTarget.value)}
              placeholder={t('settings.llm.temperature')}
              aria-label={t('settings.llm.temperature')}
              title={t('settings.llm.temperature')}
            />
            <select
              value={preset.reasoningEffort ?? ''}
              onChange={(e) => handleEpReasoningChange(preset, e.currentTarget.value)}
              aria-label={t('settings.llm.reasoningEffort')}
              title={t('settings.llm.reasoningEffort')}
            >
              <option value="">{t('settings.llm.reasoningEffortNotSent')}</option>
              {REASONING_EFFORT_OPTIONS.map((effort) => (
                <option key={effort} value={effort}>
                  {effort}
                </option>
              ))}
            </select>
          </div>
        </div>
      )
    }

    const badges = getPresetBadges(preset)
    const provider = config.providers.find((p) => p.id === preset.providerId)
    const isNetworkPreset = provider ? isNetworkProviderBaseUrl(provider.baseUrl) : false
    return (
      <div class={`model-row${isNetworkPreset ? ' model-row-network' : ''}`} key={preset.id}>
        <button type="button" class="model-row-main" onClick={() => handleOpenEditPreset(preset)}>
          <span class="model-row-label">{preset.label}</span>
          <span class="model-row-model">{preset.model}</span>
          <span class="model-row-provider">{providerLabelFor(config, preset.providerId)}</span>
        </button>
        {badges.length > 0 ? (
          <span class="model-row-badges">
            {badges.map((badge) => (
              <span key={badge} class="task-badge">
                {badge}
              </span>
            ))}
          </span>
        ) : null}
      </div>
    )
  }

  function renderAddPresetTile() {
    if (config.providers.length === 0) {
      return (
        <button type="button" class="grid-add-tile" disabled title={t('settings.llm.addModelNeedConnection')}>
          <Plus size={16} />
          <span>{t('settings.llm.addPreset')}</span>
        </button>
      )
    }
    if (addingPreset) {
      const apProvider = config.providers.find((p) => p.id === apProviderId)
      const isNetworkProvider = apProvider ? isNetworkProviderBaseUrl(apProvider.baseUrl) : false
      return (
        <div class="model-row model-row-editing model-row-add" ref={activeRowRef}>
          <div class="model-row-edit-fields">
            <input value={apLabel} onInput={(e) => setApLabel(e.currentTarget.value)} placeholder={t('settings.llm.presetLabel')} autoComplete="off" />
            <select value={apProviderId} onChange={(e) => handleApProviderChange(e.currentTarget.value)}>
              <option value="" disabled>
                {t('settings.llm.selectConnectionPlaceholder')}
              </option>
              {config.providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label || hostLabelFor(p.baseUrl)}
                </option>
              ))}
            </select>
            <div class="connection-form-model-field">
              {!apProviderId ? (
                <select value="" disabled>
                  <option value="">{t('settings.llm.modelSelectConnectionFirst')}</option>
                </select>
              ) : isNetworkProvider ? (
                <input
                  value={apModel}
                  onInput={(e) => setApModel(e.currentTarget.value)}
                  onBlur={() => handleSaveAddPreset()}
                  placeholder={t('settings.llm.model')}
                />
              ) : (
                <ModelField
                  id="set-add-preset-model"
                  value={apModel}
                  baseUrl={apProvider?.baseUrl ?? ''}
                  apiKey={apProvider?.apiKey ?? ''}
                  onChange={(value) => {
                    setApModel(value)
                    handleSaveAddPreset(value)
                  }}
                />
              )}
            </div>
          </div>
          <div class="model-row-add-actions">
            <button type="button" class="connection-form-btn" onClick={() => setAddingPreset(false)}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )
    }
    return (
      <button type="button" class="grid-add-tile" onClick={handleOpenAddPreset}>
        <Plus size={16} />
        <span>{t('settings.llm.addPreset')}</span>
      </button>
    )
  }

  return (
    <div class="settings-tab-panel">
      <div class="server-list-header">
        <label>{t('settings.llm.providersTitle')}</label>
      </div>
      <div class="settings-flat-section settings-flat-section-connection">
        {config.providers.length === 0 && !addingProvider ? <p class="hint">{t('settings.llm.noProviders')}</p> : null}
        <div class="model-row-list">
          {config.providers.map((provider) => renderProviderRow(provider))}
          {renderAddProviderTile()}
        </div>
      </div>

      <div class="server-list-header">
        <label>{t('settings.llm.presetsTitle')}</label>
      </div>
      <div class="settings-flat-section settings-flat-section-models">
        {config.providers.length > 0 && config.presets.length === 0 && !addingPreset ? (
          <p class="hint">{t('settings.llm.noPresets')}</p>
        ) : null}
        <div class="model-row-list">
          {config.presets.map((preset) => renderModelRow(preset))}
          {renderAddPresetTile()}
        </div>
      </div>
      <p class="hint">{t('settings.llm.appendOnlyNote')}</p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// AI Network tab: Room ID + two role cards (consumer / provider), per
// llm-settings-common-v1.md §3.3. The consumer role reuses lib/aiNetwork.ts's
// long-lived `networkClient` (unchanged). The provider role is new: this app
// previously only re-exported `useNetworkProvider` (lib/aiNetwork.ts) without
// wiring it up anywhere. `callLlm` enforces the named-but-unshared rejection
// (§4.5): a model name not in the checked "share" list is refused rather than
// silently answered. `synthesize` is only advertised when the shared TTS
// config resolves to a real HTTP connection (never `mist-network://` —
// §4.5's loopback guard, since answering with a network-resolved TTS would
// just bounce the request back into the room).

interface NetworkTabProps {
  config: SharedLlmConfigV1
  onChange: (config: SharedLlmConfigV1) => void
}

function NetworkTab({ config, onChange }: NetworkTabProps) {
  const [roomIdDraft, setRoomIdDraft] = useState(config.network.roomId)
  useEffect(() => setRoomIdDraft(config.network.roomId), [config.network.roomId])

  function commitRoomId(): void {
    const trimmed = roomIdDraft.trim()
    if (trimmed === config.network.roomId) return
    const next = cloneConfig(config)
    next.network = { roomId: trimmed }
    saveLlmConfig(next)
    onChange(next)
  }

  const [consumerEnabled, setConsumerEnabled] = useState(loadNetworkEnabled)
  useConsumerConnection(networkClient, { enabled: consumerEnabled, roomId: config.network.roomId })
  const consumerStatus = useConsumerStatus(networkClient)
  const messages = getLocale() === 'ja' ? MESSAGES_JA : MESSAGES_EN

  function toggleConsumer(): void {
    const next = !consumerEnabled
    setConsumerEnabled(next)
    saveNetworkEnabled(next)
  }

  const [providerEnabled, setProviderEnabled] = useState(loadNetworkProviderEnabled)
  const [sharedPresetIds, setSharedPresetIds] = useState<string[]>(loadNetworkProviderPresetIds)

  function toggleProvider(): void {
    const next = !providerEnabled
    setProviderEnabled(next)
    saveNetworkProviderEnabled(next)
  }

  function toggleShare(presetId: string, checked: boolean): void {
    const next = checked ? [...sharedPresetIds, presetId] : sharedPresetIds.filter((id) => id !== presetId)
    setSharedPresetIds(next)
    saveNetworkProviderPresetIds(next)
  }

  // Presets shareable to the room: must resolve to a real HTTP provider — a
  // preset whose provider is itself the mist-network:// pseudo-provider
  // (imported from a room) can't be re-shared (checklist #3, re-share loop).
  const eligiblePresets = useMemo(
    () =>
      config.presets.filter((preset) => {
        const provider = config.providers.find((p) => p.id === preset.providerId)
        return provider !== undefined && !isNetworkProviderBaseUrl(provider.baseUrl)
      }),
    [config.presets, config.providers],
  )

  const sharedPresets = useMemo(
    () => eligiblePresets.filter((preset) => sharedPresetIds.includes(preset.id)),
    [eligiblePresets, sharedPresetIds],
  )

  // Provider-side chat resolver (llm-settings-common-v1.md §4.5): a request
  // naming a model must match one of the checked/shared presets' advertised
  // name, or is rejected outright — never silently answered by an unshared
  // preset. No model at all falls back to this device's own default preset.
  const callLlm: LlmCallFn = async (chatMessages, model, onDelta) => {
    let target: ResolvedLlmTargetV1 | null
    if (!model) {
      target = resolvePreset(config)
    } else {
      const preset = sharedPresets.find((p) => advertisedModelName(p) === model)
      if (!preset) throw new Error(t('settings.network.modelNotShared'))
      target = resolvePreset(config, preset.id)
    }
    if (!target) throw new Error(t('errors.llmNotConfigured'))
    return requestApiChatCompletionStreaming(target, chatMessages, target.model, onDelta)
  }

  const synthesize: SynthesizeFn | undefined = useMemo(() => {
    const resolved = resolveVoice(config, 'tts')
    if (!resolved || isNetworkProviderBaseUrl(resolved.baseUrl)) return undefined
    return async (text, _model, voice) => {
      const blob = await synthesizeSpeech({
        connection: { baseUrl: resolved.baseUrl, apiKey: resolved.apiKey },
        model: resolved.model,
        voice: voice || resolved.voice || 'alloy',
        text,
      })
      return { blob, mime: 'audio/mpeg' }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.tts, config.providers, config.defaultPresetId, config.presets])

  const advertisedModels = useMemo(() => sharedPresets.map((preset) => advertisedModelName(preset)), [sharedPresets])

  const providerResult = useNetworkProvider({
    enabled: providerEnabled,
    roomId: config.network.roomId,
    createNode: createMistNode,
    nodeIdStorageKey: NODE_ID_STORAGE_KEY,
    callLlm,
    synthesize,
    advertisedModels,
  })

  return (
    <div class="settings-tab-panel">
      <div class="set-field">
        <label for="set-network-room">{t('settings.network.roomId')}</label>
        <input
          id="set-network-room"
          type="text"
          value={roomIdDraft}
          placeholder={t('settings.network.roomIdPlaceholder')}
          onInput={(e) => setRoomIdDraft(e.currentTarget.value)}
          onBlur={commitRoomId}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
      </div>

      <div class="settings-role-group">
        <div class="settings-role-card">
          <label class="settings-role-head">
            <input type="checkbox" checked={consumerEnabled} onChange={toggleConsumer} />
            <span class="settings-role-title">
              <Network size={15} />
              {t('settings.network.consumerToggle')}
            </span>
          </label>
          <p class="settings-role-desc">{t('settings.network.consumerHint')}</p>
          {consumerEnabled ? (
            <div class="settings-role-body">
              <ConsumerStatusIndicator status={consumerStatus} messages={messages} variant="detailed" />
            </div>
          ) : null}
        </div>

        <div class="settings-role-card">
          <label class="settings-role-head">
            <input type="checkbox" checked={providerEnabled} onChange={toggleProvider} />
            <span class="settings-role-title">
              <Server size={15} />
              {t('settings.network.providerToggle')}
            </span>
          </label>
          <p class="settings-role-desc">{t('settings.network.providerHint')}</p>
          {providerEnabled ? (
            <div class="settings-role-body">
              <div class="network-share-models">
                <label>{t('settings.network.shareModelsHeading')}</label>
                {eligiblePresets.length === 0 ? (
                  <p class="hint">{t('settings.network.shareModelsEmpty')}</p>
                ) : (
                  <div class="network-share-list">
                    {eligiblePresets.map((preset) => (
                      <label class="network-share-item" key={preset.id}>
                        <input
                          type="checkbox"
                          checked={sharedPresetIds.includes(preset.id)}
                          onChange={(e) => toggleShare(preset.id, e.currentTarget.checked)}
                        />
                        <span class="network-share-item-label">{preset.label || preset.model}</span>
                        <span class="network-share-item-model">
                          {preset.model} · {providerLabelFor(config, preset.providerId)}
                        </span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
              <ProviderStatusPanel
                status={providerResult.status}
                messages={messages}
                statusUpdatedAt={providerResult.statusUpdatedAt}
                errorMessage={providerResult.errorMessage}
                ownNodeId={providerResult.ownNodeId}
                peers={providerResult.peers}
                consumerCount={providerResult.consumerCount}
                logs={providerResult.logs}
              />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// タスク tab: one row per generation task (既定 / Vision / デッキ構成 /
// スライド生成 / TTS), each a preset picker, plus the fan-out width and
// pipeline mode. Labels stay one word; the explanation moves to a hover
// tooltip (`data-tip`) per llm-settings-common-v1.md §3.2 — no more
// always-visible hint paragraphs. "デッキ構成"/"スライド生成" replace the
// internal "orchestrator"/"worker" naming in the UI only (data fields keep
// their existing names — see localPrefs.ts's GenerateRolePrefs — since
// nothing else references the UI label).
//
// The TTS row is a single model picker (no engine selector): browser
// (unset) / "AI Networkにおまかせ" (only once a room's pseudo-provider has
// been imported) / a shared preset card / a read-only fallback for a stored
// pair that matches none of the above. voice/speed stay in the same row,
// hidden for the browser/network-auto choices. reasoning_effort is NOT
// duplicated here as a separate control — tc-presenter bakes it into the
// preset itself (ModelPresetV1.reasoningEffort, edited on the AI接続 tab),
// so picking a preset here already carries its reasoning effort; see the
// worker's final report for the rationale of not adding a second,
// preset-overriding control.

interface TasksTabProps {
  config: SharedLlmConfigV1
  onChange: (config: SharedLlmConfigV1) => void
}

function TasksTab({ config, onChange }: TasksTabProps) {
  const [prefs, setPrefs] = useState<GenerateRolePrefs>(loadGenerateRolePrefs)
  const [visionPresetId, setVisionPresetId] = useState(loadVisionPresetId)

  // Status-only subscription to the shared networkClient singleton (does not
  // itself open/close the connection — that lifecycle lives in NetworkTab's
  // useConsumerConnection call, see that component). Gates AI-Network-derived
  // presets/options in the selects below (option-network styling, task-badge
  // badge, and hiding those options entirely while disconnected).
  const consumerStatus = useConsumerStatus(networkClient)
  const networkConnected = consumerStatus.phase === 'connected'

  function updatePrefs(patch: Partial<GenerateRolePrefs>): void {
    const next = { ...prefs, ...patch }
    setPrefs(next)
    saveGenerateRolePrefs(next)
  }

  function handleVisionChange(next: string): void {
    setVisionPresetId(next)
    saveVisionPresetId(next)
  }

  function isNetworkPresetProvider(providerId: string): boolean {
    const provider = config.providers.find((p) => p.id === providerId)
    return provider ? isNetworkProviderBaseUrl(provider.baseUrl) : false
  }

  // A preset that has since vanished from the shared config would render the
  // <select> on its first option while silently keeping the stale id — keep
  // it selectable instead, mirroring mergeOptions' philosophy for models.
  const presetOptions = (selected: string) => {
    const known = config.presets.map((p) => ({ id: p.id, label: p.label || p.model, isNetwork: isNetworkPresetProvider(p.providerId) }))
    if (selected && !config.presets.some((p) => p.id === selected)) known.push({ id: selected, label: selected, isNetwork: false })
    return known
  }

  // --- TTS row -----------------------------------------------------------

  const networkProviderId = config.providers.find((p) => isNetworkProviderBaseUrl(p.baseUrl))?.id ?? ''
  const ttsConfig = config.tts
  const matchedTtsPreset = config.presets.find((p) => p.providerId === ttsConfig?.providerId && p.model === ttsConfig?.model)
  const isTtsNetworkAuto =
    networkProviderId !== '' && ttsConfig?.providerId === networkProviderId && ttsConfig?.model === NETWORK_VOICE_AUTO_MODEL
  const ttsSelectValue = isTtsNetworkAuto
    ? '__network__'
    : matchedTtsPreset
      ? matchedTtsPreset.id
      : ttsConfig?.model?.trim() && ttsConfig.model !== NETWORK_VOICE_AUTO_MODEL
        ? '__current__'
        : ''

  const ttsProvider = ttsConfig?.providerId
    ? config.providers.find((p) => p.id === ttsConfig.providerId)
    : (() => {
        const resolved = resolvePreset(config)
        return resolved ? config.providers.find((p) => p.id === resolved.providerId) : undefined
      })()
  const ttsBaseUrl = ttsProvider?.baseUrl ?? ''
  const ttsHasModel = Boolean(ttsConfig?.model?.trim())
  const ttsIsNetwork = isTtsNetworkAuto || (ttsProvider ? isNetworkProviderBaseUrl(ttsProvider.baseUrl) : false)
  const ttsShowVoicePicker = ttsHasModel && !ttsIsNetwork
  const ttsUnresolvedWarning = ttsHasModel && !ttsIsNetwork && !ttsBaseUrl.trim()

  function saveTts(patch: { providerId?: string; model: string; voice?: string; speed?: number }): void {
    const next = cloneConfig(config)
    const voiceConfig: VoiceConfigV1 = { model: patch.model }
    if (patch.providerId) voiceConfig.providerId = patch.providerId
    if (patch.voice) voiceConfig.voice = patch.voice
    if (patch.speed !== undefined) voiceConfig.speed = patch.speed
    next.tts = voiceConfig
    saveLlmConfig(next)
    onChange(next)
  }

  function handleTtsModelSelect(value: string): void {
    if (value === '__current__') return
    if (value === '') {
      saveTts({ model: '' })
      return
    }
    if (value === '__network__') {
      saveTts({ providerId: networkProviderId, model: NETWORK_VOICE_AUTO_MODEL })
      return
    }
    const preset = config.presets.find((p) => p.id === value)
    if (!preset) return
    saveTts({ providerId: preset.providerId, model: preset.model, voice: ttsConfig?.voice, speed: ttsConfig?.speed })
  }

  function handleTtsVoiceChange(voice: string): void {
    saveTts({ providerId: ttsConfig?.providerId, model: ttsConfig?.model ?? '', voice, speed: ttsConfig?.speed })
  }

  const [ttsSpeedDraft, setTtsSpeedDraft] = useState(ttsConfig?.speed !== undefined ? String(ttsConfig.speed) : '')
  useEffect(() => {
    setTtsSpeedDraft(ttsConfig?.speed !== undefined ? String(ttsConfig.speed) : '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ttsConfig?.speed])

  function handleTtsSpeedBlur(): void {
    const trimmed = ttsSpeedDraft.trim()
    const parsed = trimmed ? Number(trimmed) : undefined
    saveTts({
      providerId: ttsConfig?.providerId,
      model: ttsConfig?.model ?? '',
      voice: ttsConfig?.voice,
      speed: parsed !== undefined && Number.isFinite(parsed) ? parsed : undefined,
    })
  }

  const [ttsTestState, setTtsTestState] = useState<'idle' | 'loading' | 'error'>('idle')
  async function handleTtsTest(): Promise<void> {
    setTtsTestState('loading')
    try {
      if (!ttsProvider || !ttsConfig?.model?.trim()) throw new Error(t('errors.llmNotConfigured'))
      const blob = await synthesizeSpeech({
        connection: { baseUrl: ttsProvider.baseUrl, apiKey: ttsProvider.apiKey },
        model: ttsConfig.model,
        voice: ttsConfig.voice || 'alloy',
        text: t('settings.tts.testText'),
      })
      const url = URL.createObjectURL(blob)
      const audio = new Audio(url)
      audio.addEventListener('ended', () => URL.revokeObjectURL(url))
      await audio.play().catch(() => undefined)
      setTtsTestState('idle')
    } catch {
      setTtsTestState('error')
    }
  }

  return (
    <div class="settings-tab-panel">
      <div class="task-model-item">
        <span data-tip={t('settings.tasks.defaultTip')}>{t('settings.tasks.defaultLabel')}</span>
        <div class="task-model-fields">
          <div class="task-model-field">
            <select
              value={config.defaultPresetId}
              onChange={(e) => {
                const next = cloneConfig(config)
                next.defaultPresetId = e.currentTarget.value
                saveLlmConfig(next)
                onChange(next)
              }}
              aria-label={t('settings.tasks.defaultLabel')}
            >
              <option value="">{t('settings.llm.reasoningEffortNotSent')}</option>
              {config.presets
                .filter((preset) => networkConnected || !isNetworkPresetProvider(preset.providerId))
                .map((preset) => (
                  <option key={preset.id} value={preset.id} class={isNetworkPresetProvider(preset.providerId) ? 'option-network' : undefined}>
                    {preset.label || preset.model}
                  </option>
                ))}
            </select>
            {networkConnected && isNetworkPresetProvider(config.presets.find((p) => p.id === config.defaultPresetId)?.providerId ?? '') ? (
              <span class="task-badge task-badge-network">{t('settings.llm.badgeNetwork')}</span>
            ) : null}
          </div>
        </div>
      </div>

      <div class="task-model-item">
        <span data-tip={t('settings.vision.tip')}>{t('settings.vision.label')}</span>
        <div class="task-model-fields">
          <div class="task-model-field">
            <select value={visionPresetId} onChange={(e) => handleVisionChange(e.currentTarget.value)} aria-label={t('settings.vision.label')}>
              <option value="">{t('settings.vision.presetNone')}</option>
              {presetOptions(visionPresetId)
                .filter((p) => networkConnected || !p.isNetwork)
                .map((p) => (
                  <option key={p.id} value={p.id} class={p.isNetwork ? 'option-network' : undefined}>
                    {p.label}
                  </option>
                ))}
            </select>
            {networkConnected && isNetworkPresetProvider(config.presets.find((p) => p.id === visionPresetId)?.providerId ?? '') ? (
              <span class="task-badge task-badge-network">{t('settings.llm.badgeNetwork')}</span>
            ) : null}
          </div>
        </div>
      </div>

      <div class="task-model-item">
        <span data-tip={t('settings.tasks.orchestratorTip')}>{t('settings.tasks.orchestratorLabel')}</span>
        <div class="task-model-fields">
          <div class="task-model-field">
            <select
              value={prefs.orchestratorPresetId}
              onChange={(e) => updatePrefs({ orchestratorPresetId: e.currentTarget.value })}
              aria-label={t('settings.tasks.orchestratorLabel')}
            >
              <option value="">{t('settings.tasks.orchestratorDefault')}</option>
              {presetOptions(prefs.orchestratorPresetId)
                .filter((p) => networkConnected || !p.isNetwork)
                .map((p) => (
                  <option key={p.id} value={p.id} class={p.isNetwork ? 'option-network' : undefined}>
                    {p.label}
                  </option>
                ))}
            </select>
            {networkConnected && isNetworkPresetProvider(config.presets.find((p) => p.id === prefs.orchestratorPresetId)?.providerId ?? '') ? (
              <span class="task-badge task-badge-network">{t('settings.llm.badgeNetwork')}</span>
            ) : null}
          </div>
        </div>
      </div>

      <div class="task-model-item">
        <span data-tip={t('settings.tasks.workerTip')}>{t('settings.tasks.workerLabel')}</span>
        <div class="task-model-fields">
          <div class="task-model-field">
            <select
              value={prefs.workerPresetId}
              onChange={(e) => updatePrefs({ workerPresetId: e.currentTarget.value })}
              aria-label={t('settings.tasks.workerLabel')}
            >
              <option value="">{t('settings.tasks.workerDefault')}</option>
              {presetOptions(prefs.workerPresetId)
                .filter((p) => networkConnected || !p.isNetwork)
                .map((p) => (
                  <option key={p.id} value={p.id} class={p.isNetwork ? 'option-network' : undefined}>
                    {p.label}
                  </option>
                ))}
            </select>
            {networkConnected && isNetworkPresetProvider(config.presets.find((p) => p.id === prefs.workerPresetId)?.providerId ?? '') ? (
              <span class="task-badge task-badge-network">{t('settings.llm.badgeNetwork')}</span>
            ) : null}
          </div>
          <div class="task-model-field">
            <input
              type="number"
              min={1}
              max={8}
              value={prefs.workerConcurrency}
              onChange={(e) => updatePrefs({ workerConcurrency: clampWorkerConcurrency(Number(e.currentTarget.value)) })}
              aria-label={t('settings.tasks.concurrency')}
              title={t('settings.tasks.concurrency')}
            />
          </div>
        </div>
      </div>

      <div class="task-model-item">
        <span data-tip={t('settings.tasks.ttsTip')}>{t('settings.tasks.ttsLabel')}</span>
        <div class="task-model-fields">
          <div class="task-model-field">
            <select value={ttsSelectValue} onChange={(e) => handleTtsModelSelect(e.currentTarget.value)} aria-label={t('settings.tasks.ttsLabel')}>
              <option value="">{t('settings.tts.browserOption')}</option>
              {networkProviderId && networkConnected ? (
                <option value="__network__" class="option-network">
                  {t('settings.tts.networkAutoOption')}
                </option>
              ) : null}
              {ttsConfig?.model?.trim() && !matchedTtsPreset && !isTtsNetworkAuto ? (
                <option value="__current__">{ttsConfig.model}</option>
              ) : null}
              {config.presets
                .filter((preset) => networkConnected || !isNetworkPresetProvider(preset.providerId))
                .map((preset) => (
                  <option key={preset.id} value={preset.id} class={isNetworkPresetProvider(preset.providerId) ? 'option-network' : undefined}>
                    {preset.label || preset.model}
                  </option>
                ))}
            </select>
            {networkConnected && ttsIsNetwork ? <span class="task-badge task-badge-network">{t('settings.llm.badgeNetwork')}</span> : null}
          </div>
          {ttsShowVoicePicker ? (
            <div class="task-model-field">
              <VoiceField
                id="set-task-tts-voice"
                value={ttsConfig?.voice ?? ''}
                baseUrl={ttsBaseUrl}
                apiKey={ttsProvider?.apiKey ?? ''}
                onChange={handleTtsVoiceChange}
              />
            </div>
          ) : null}
          {ttsShowVoicePicker ? (
            <div class="task-model-field">
              <input
                type="text"
                inputMode="decimal"
                value={ttsSpeedDraft}
                onInput={(e) => setTtsSpeedDraft(e.currentTarget.value)}
                onBlur={handleTtsSpeedBlur}
                placeholder={t('settings.tts.speed')}
                aria-label={t('settings.tts.speed')}
              />
            </div>
          ) : null}
          <div class="task-model-field">
            <button type="button" class="set-icon-btn" onClick={() => void handleTtsTest()} disabled={!ttsHasModel || ttsIsNetwork || ttsTestState === 'loading'} title={t('settings.tts.test')}>
              <Play size={14} />
            </button>
          </div>
        </div>
      </div>
      {ttsUnresolvedWarning ? <p class="error-text">{t('settings.tts.unresolvedWarning')}</p> : null}
      {ttsTestState === 'error' ? <p class="error-text">{t('settings.tts.testError', { message: '' })}</p> : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Language + onboarding replay. Always visible above the tab bar (not a tab
// of their own), matching tc-translate's ui-language-row placement.

function LocaleRow() {
  const [locale, setLocaleState] = useState<Locale>(getLocale())
  useEffect(() => subscribeLocale(setLocaleState), [])

  return (
    <div class="set-locale-row">
      <div class="set-segmented">
        <button type="button" class={`set-segmented__item${locale === 'en' ? ' is-active' : ''}`} onClick={() => setLocale('en')}>
          {t('settings.locale.en')}
        </button>
        <button type="button" class={`set-segmented__item${locale === 'ja' ? ' is-active' : ''}`} onClick={() => setLocale('ja')}>
          {t('settings.locale.ja')}
        </button>
      </div>
      <button type="button" class="set-btn" onClick={() => requestOnboarding()} title={t('settings.onboarding.hint')}>
        <Sparkles size={14} />
        {t('settings.onboarding.open')}
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------

type SettingsSubTab = 'connection' | 'network' | 'tasks'

const SUB_TABS: Array<{ id: SettingsSubTab; labelKey: 'settings.tabs.connection' | 'settings.tabs.network' | 'settings.tabs.tasks' }> = [
  { id: 'connection', labelKey: 'settings.tabs.connection' },
  { id: 'network', labelKey: 'settings.tabs.network' },
  { id: 'tasks', labelKey: 'settings.tabs.tasks' },
]

export default function SettingsTab(_props: SettingsTabProps) {
  const [config, setConfig] = useState<SharedLlmConfigV1>(() => loadLlmConfig() ?? emptyLlmConfig())
  const [activeTab, setActiveTab] = useState<SettingsSubTab>('connection')

  useEffect(() => subscribeLlmConfig((next) => setConfig(next ?? emptyLlmConfig())), [])

  return (
    <div class="set-tab">
      <LocaleRow />

      <div class="settings-tab-bar" role="tablist" aria-label={t('settings.tabs.ariaLabel')}>
        {SUB_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            class={`settings-tab ${activeTab === tab.id ? 'active' : ''}`}
            aria-selected={activeTab === tab.id}
            onClick={() => setActiveTab(tab.id)}
          >
            {t(tab.labelKey)}
          </button>
        ))}
      </div>

      {activeTab === 'connection' ? <ConnectionTab config={config} onChange={setConfig} /> : null}
      {activeTab === 'network' ? <NetworkTab config={config} onChange={setConfig} /> : null}
      {activeTab === 'tasks' ? <TasksTab config={config} onChange={setConfig} /> : null}
    </div>
  )
}

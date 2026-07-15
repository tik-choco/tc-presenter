// Wave2 C owns this feature: LLM/TTS provider + preset management (against
// the shared tc-shared-llm-config-v1 config, see lib/llmConfig.ts) and AI
// Network room/status toggles (lib/aiNetwork.ts), plus theme/locale.
//
// Contract (types.ts): default-export a Preact component accepting
// `SettingsTabProps` (currently empty — this tab manages its own state
// directly against lib/llmConfig.ts rather than through app.tsx).
import { useEffect, useState } from 'preact/hooks'
import type { JSX } from 'preact'
import { RefreshCw } from 'lucide-preact'
import { MESSAGES_EN, MESSAGES_JA } from '@tik-choco/mistai'
import { useConsumerConnection, useConsumerStatus, ConsumerStatusIndicator } from '@tik-choco/mistai/preact'
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
  resolvePreset,
  saveLlmConfig,
  subscribeLlmConfig,
  type SharedLlmConfigV1,
  type VoiceConfigV1,
} from '../../lib/llmConfig'
import { networkClient } from '../../lib/aiNetwork'
import { synthesizeSpeech } from '../../lib/tts'
import { isBrowserTtsSupported, listBrowserVoices, createBrowserSpeech } from '../../lib/browserTts'
import { loadTtsLangRules, saveTtsLangRules, normalizeLang, type TtsEngineRule, type TtsLangRulesV1 } from '../../lib/ttsLangRules'
import type { SettingsTabProps } from '../../types'
import { loadNetworkEnabled, loadVisionPresetId, saveNetworkEnabled, saveVisionPresetId } from './localPrefs'

const OLLAMA_BASE_URL = 'http://localhost:11434/v1'
const LM_STUDIO_BASE_URL = 'http://localhost:1234/v1'

/** 新規プリセット作成時の既定 reasoning_effort — 思考なしで応答を速くするため "none"。
 * 空文字にすればパラメータ自体を送らない従来の挙動に戻せる(lib/llm.ts の apiConfig 参照)。 */
const DEFAULT_REASONING_EFFORT = 'none'

function cloneConfig(config: SharedLlmConfigV1): SharedLlmConfigV1 {
  return { ...config, providers: [...config.providers], presets: [...config.presets], network: { ...config.network } }
}

// ---------------------------------------------------------------------------
// Model/voice pickers (fetch from the provider's /models or voices endpoint,
// with a manual-entry fallback for offline use or endpoints that can't list
// options). Ported from tc-news's src/views/SettingsView.tsx.

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
 * list models. Shared by the LLM preset form's model field and the TTS
 * section's model field. */
function ModelField(props: { id: string; value: string; baseUrl: string; apiKey: string; onChange: (model: string) => void }) {
  const { id, value, baseUrl, apiKey, onChange } = props
  const { options, status, errorMessage, refresh } = useModelOptions(baseUrl, apiKey)

  const selectableOptions = mergeOptions(value, options)
  const canFetch = baseUrl.trim().length > 0
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

/** Voice picker for the TTS section: mirrors ModelField's UX but sources
 * options from useVoiceOptions(baseUrl, apiKey). Most OpenAI-compatible TTS
 * endpoints don't expose a voices-listing endpoint, so on a fetch error we
 * fall back to OPENAI_TTS_VOICES (the standard OpenAI voice set) instead of
 * leaving the select empty. */
function VoiceField(props: { id: string; value: string; baseUrl: string; apiKey: string; onChange: (voice: string) => void }) {
  const { id, value, baseUrl, apiKey, onChange } = props
  const { options, status, refresh } = useVoiceOptions(baseUrl, apiKey)

  const fetchedOrFallback = status === 'error' ? OPENAI_TTS_VOICES : options
  const selectableOptions = mergeOptions(value, fetchedOrFallback)
  const canFetch = baseUrl.trim().length > 0
  const statusText =
    status === 'loading'
      ? t('common.loading')
      : status === 'error'
        ? t('settings.tts.voiceListErrorFallback')
        : status === 'done'
          ? t('settings.tts.voiceListFetched', { count: options.length })
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
// LLM connections

interface LlmSectionProps {
  config: SharedLlmConfigV1
  onChange: (config: SharedLlmConfigV1) => void
}

function LlmSection({ config, onChange }: LlmSectionProps) {
  const [label, setLabel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')

  const [presetLabel, setPresetLabel] = useState('')
  const [presetProviderId, setPresetProviderId] = useState('')
  const [presetModel, setPresetModel] = useState('')
  const [presetTemperature, setPresetTemperature] = useState('')
  const [presetReasoningEffort, setPresetReasoningEffort] = useState(DEFAULT_REASONING_EFFORT)

  const presetProvider = config.providers.find((p) => p.id === presetProviderId)

  function quickFill(kind: 'ollama' | 'lmstudio') {
    if (kind === 'ollama') {
      setBaseUrl(OLLAMA_BASE_URL)
      setLabel(t('settings.llm.presetFillOllama'))
    } else {
      setBaseUrl(LM_STUDIO_BASE_URL)
      setLabel(t('settings.llm.presetFillLmStudio'))
    }
  }

  function handleAddProvider(event: JSX.TargetedEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!baseUrl.trim()) return
    const next = cloneConfig(config)
    ensureProvider(next, { label: label.trim() || undefined, baseUrl: baseUrl.trim(), apiKey })
    saveLlmConfig(next)
    onChange(next)
    setLabel('')
    setBaseUrl('')
    setApiKey('')
  }

  function handleAddPreset(event: JSX.TargetedEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!presetProviderId || !presetModel.trim()) return
    const next = cloneConfig(config)
    const temperature = presetTemperature.trim() ? Number(presetTemperature.trim()) : undefined
    ensurePreset(next, {
      label: presetLabel.trim() || undefined,
      providerId: presetProviderId,
      model: presetModel.trim(),
      temperature: temperature !== undefined && Number.isFinite(temperature) ? temperature : undefined,
      reasoningEffort: presetReasoningEffort.trim() || undefined,
    })
    saveLlmConfig(next)
    onChange(next)
    setPresetLabel('')
    setPresetModel('')
    setPresetTemperature('')
    setPresetReasoningEffort(DEFAULT_REASONING_EFFORT)
  }

  function handleSetDefault(id: string) {
    const next = cloneConfig(config)
    next.defaultPresetId = id
    saveLlmConfig(next)
    onChange(next)
  }

  return (
    <div class="set-panel">
      <div class="set-panel__title">{t('settings.llm.title')}</div>
      <p class="set-panel__hint">{t('settings.llm.appendOnlyNote')}</p>

      <div class="set-section">
        <div class="set-section__title">{t('settings.llm.providersTitle')}</div>
        {config.providers.length === 0 ? (
          <div class="set-empty">{t('settings.llm.noProviders')}</div>
        ) : (
          <div class="set-list">
            {config.providers.map((provider) => (
              <div class="set-item" key={provider.id}>
                <div class="set-item__main">
                  <div class="set-item__label">{provider.label}</div>
                  <div class="set-item__detail">{provider.baseUrl}</div>
                </div>
              </div>
            ))}
          </div>
        )}

        <form onSubmit={handleAddProvider}>
          <div class="set-quickfill">
            <button type="button" class="set-btn" onClick={() => quickFill('ollama')}>
              {t('settings.llm.presetFillOllama')}
            </button>
            <button type="button" class="set-btn" onClick={() => quickFill('lmstudio')}>
              {t('settings.llm.presetFillLmStudio')}
            </button>
          </div>
          <div class="set-grid">
            <div class="set-field">
              <label for="set-provider-label">{t('settings.llm.providerLabel')}</label>
              <input id="set-provider-label" type="text" value={label} onInput={(e) => setLabel(e.currentTarget.value)} />
            </div>
            <div class="set-field">
              <label for="set-provider-baseurl">{t('settings.llm.baseUrl')}</label>
              <input
                id="set-provider-baseurl"
                type="text"
                value={baseUrl}
                onInput={(e) => setBaseUrl(e.currentTarget.value)}
              />
            </div>
            <div class="set-field">
              <label for="set-provider-apikey">{t('settings.llm.apiKey')}</label>
              <input
                id="set-provider-apikey"
                type="password"
                value={apiKey}
                onInput={(e) => setApiKey(e.currentTarget.value)}
              />
            </div>
          </div>
          <button type="submit" class="set-btn set-btn--primary" disabled={!baseUrl.trim()}>
            {t('settings.llm.addProvider')}
          </button>
        </form>
      </div>

      <div class="set-section">
        <div class="set-section__title">{t('settings.llm.presetsTitle')}</div>
        {config.presets.length === 0 ? (
          <div class="set-empty">{t('settings.llm.noPresets')}</div>
        ) : (
          <div class="set-list">
            {config.presets.map((preset) => (
              <div class="set-item" key={preset.id}>
                <div class="set-item__main">
                  <div class="set-item__label">{preset.label}</div>
                  <div class="set-item__detail">{preset.model}</div>
                </div>
                {config.defaultPresetId === preset.id ? (
                  <span class="set-badge">{t('settings.llm.isDefault')}</span>
                ) : (
                  <button type="button" class="set-btn" onClick={() => handleSetDefault(preset.id)}>
                    {t('settings.llm.setDefault')}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        <form onSubmit={handleAddPreset}>
          <div class="set-grid">
            <div class="set-field">
              <label for="set-preset-label">{t('settings.llm.presetLabel')}</label>
              <input
                id="set-preset-label"
                type="text"
                value={presetLabel}
                onInput={(e) => setPresetLabel(e.currentTarget.value)}
              />
            </div>
            <div class="set-field">
              <label for="set-preset-provider">{t('settings.llm.provider')}</label>
              <select
                id="set-preset-provider"
                value={presetProviderId}
                onChange={(e) => setPresetProviderId(e.currentTarget.value)}
              >
                <option value="">—</option>
                {config.providers.map((provider) => (
                  <option value={provider.id} key={provider.id}>
                    {provider.label}
                  </option>
                ))}
              </select>
            </div>
            <div class="set-field">
              <label for="set-preset-model">{t('settings.llm.model')}</label>
              <ModelField
                id="set-preset-model"
                value={presetModel}
                baseUrl={presetProvider?.baseUrl ?? ''}
                apiKey={presetProvider?.apiKey ?? ''}
                onChange={setPresetModel}
              />
            </div>
            <div class="set-field">
              <label for="set-preset-temp">{t('settings.llm.temperature')}</label>
              <input
                id="set-preset-temp"
                type="text"
                inputMode="decimal"
                value={presetTemperature}
                onInput={(e) => setPresetTemperature(e.currentTarget.value)}
              />
            </div>
            <div class="set-field">
              <label for="set-preset-effort">{t('settings.llm.reasoningEffort')}</label>
              <input
                id="set-preset-effort"
                type="text"
                value={presetReasoningEffort}
                onInput={(e) => setPresetReasoningEffort(e.currentTarget.value)}
              />
            </div>
          </div>
          <button
            type="submit"
            class="set-btn set-btn--primary"
            disabled={config.providers.length === 0 || !presetModel.trim() || !presetProviderId}
          >
            {t('settings.llm.addPreset')}
          </button>
        </form>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// TTS

interface TtsSectionProps {
  config: SharedLlmConfigV1
  onChange: (config: SharedLlmConfigV1) => void
}

function TtsSection({ config, onChange }: TtsSectionProps) {
  const [providerId, setProviderId] = useState(config.tts?.providerId ?? '')
  const [model, setModel] = useState(config.tts?.model ?? '')
  const [voice, setVoice] = useState(config.tts?.voice ?? '')
  const [speed, setSpeed] = useState(config.tts?.speed !== undefined ? String(config.tts.speed) : '')
  const [saved, setSaved] = useState(false)
  const [testState, setTestState] = useState<'idle' | 'loading' | 'error'>('idle')
  const [testError, setTestError] = useState('')

  // providerId explicit selection, or else the default LLM preset's provider
  // — same fallback resolveVoice() uses when actually resolving TTS at
  // runtime (lib/llmConfig.ts). Recomputed every render so the model/voice
  // pickers below always fetch against the currently selected provider.
  const ttsProvider = providerId
    ? config.providers.find((p) => p.id === providerId)
    : (() => {
        const resolved = resolvePreset(config)
        return resolved ? config.providers.find((p) => p.id === resolved.providerId) : undefined
      })()

  function handleSave(event: JSX.TargetedEvent<HTMLFormElement>) {
    event.preventDefault()
    const next = cloneConfig(config)
    const speedNum = speed.trim() ? Number(speed.trim()) : undefined
    const voiceConfig: VoiceConfigV1 = { model: model.trim() }
    if (providerId) voiceConfig.providerId = providerId
    if (voice.trim()) voiceConfig.voice = voice.trim()
    if (speedNum !== undefined && Number.isFinite(speedNum)) voiceConfig.speed = speedNum
    next.tts = voiceConfig
    saveLlmConfig(next)
    onChange(next)
    setSaved(true)
  }

  async function handleTest() {
    setTestState('loading')
    setTestError('')
    try {
      if (!ttsProvider || !model.trim()) {
        throw new Error(t('errors.llmNotConfigured'))
      }
      const blob = await synthesizeSpeech({
        connection: { baseUrl: ttsProvider.baseUrl, apiKey: ttsProvider.apiKey },
        model: model.trim(),
        voice: voice.trim() || 'alloy',
        text: t('settings.tts.testText'),
      })
      const url = URL.createObjectURL(blob)
      const audio = new Audio(url)
      audio.addEventListener('ended', () => URL.revokeObjectURL(url))
      await audio.play().catch(() => undefined)
      setTestState('idle')
    } catch (err) {
      setTestState('error')
      setTestError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div class="set-panel">
      <div class="set-panel__title">{t('settings.tts.title')}</div>
      <form onSubmit={handleSave}>
        <div class="set-grid">
          <div class="set-field">
            <label for="set-tts-provider">{t('settings.tts.provider')}</label>
            <select id="set-tts-provider" value={providerId} onChange={(e) => setProviderId(e.currentTarget.value)}>
              <option value="">{t('settings.tts.providerDefault')}</option>
              {config.providers.map((provider) => (
                <option value={provider.id} key={provider.id}>
                  {provider.label}
                </option>
              ))}
            </select>
          </div>
          <div class="set-field">
            <label for="set-tts-model">{t('settings.tts.model')}</label>
            <ModelField
              id="set-tts-model"
              value={model}
              baseUrl={ttsProvider?.baseUrl ?? ''}
              apiKey={ttsProvider?.apiKey ?? ''}
              onChange={setModel}
            />
          </div>
          <div class="set-field">
            <label for="set-tts-voice">{t('settings.tts.voice')}</label>
            <VoiceField
              id="set-tts-voice"
              value={voice}
              baseUrl={ttsProvider?.baseUrl ?? ''}
              apiKey={ttsProvider?.apiKey ?? ''}
              onChange={setVoice}
            />
          </div>
          <div class="set-field">
            <label for="set-tts-speed">{t('settings.tts.speed')}</label>
            <input
              id="set-tts-speed"
              type="text"
              inputMode="decimal"
              value={speed}
              onInput={(e) => setSpeed(e.currentTarget.value)}
            />
          </div>
        </div>
        <div class="set-quickfill">
          <button type="submit" class="set-btn set-btn--primary" onClick={() => setSaved(false)}>
            {t('settings.tts.save')}
          </button>
          <button type="button" class="set-btn" onClick={handleTest} disabled={testState === 'loading' || !model.trim()}>
            {testState === 'loading' ? t('settings.tts.testing') : t('settings.tts.test')}
          </button>
        </div>
        {saved && <div class="set-status-msg set-status-msg--ok">{t('settings.tts.saved')}</div>}
        {testState === 'error' && (
          <div class="set-status-msg set-status-msg--error">{t('settings.tts.testError', { message: testError })}</div>
        )}
      </form>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Per-language TTS overrides (lib/ttsLangRules.ts + lib/browserTts.ts). Local
// to tc-presenter only — layered on top of the shared `tts` config as
// per-language exceptions (e.g. route Japanese through the browser's
// built-in speechSynthesis while everything else keeps the shared
// OpenAI-compatible endpoint). Rules are stored locally, never written to
// the shared llmConfig record.

interface TtsLangSectionProps {
  config: SharedLlmConfigV1
}

function summarizeTtsLangRule(rule: TtsEngineRule): string {
  if (rule.engine === 'openai') {
    return rule.voice ? `${rule.model} · ${rule.voice}` : rule.model
  }
  return rule.voiceURI || t('settings.ttsLang.browserVoiceDefault')
}

function TtsLangSection({ config }: TtsLangSectionProps) {
  const [rules, setRules] = useState<TtsLangRulesV1>(loadTtsLangRules)
  const [browserVoices, setBrowserVoices] = useState<SpeechSynthesisVoice[]>([])
  const browserSupported = isBrowserTtsSupported()

  const [lang, setLang] = useState('')
  const [engine, setEngine] = useState<'openai' | 'browser'>('openai')
  const [providerId, setProviderId] = useState('')
  const [model, setModel] = useState('')
  const [voice, setVoice] = useState('')
  const [speed, setSpeed] = useState('')
  const [voiceURI, setVoiceURI] = useState('')
  const [rate, setRate] = useState('')

  const [testingLang, setTestingLang] = useState<string | null>(null)
  const [testError, setTestError] = useState<{ lang: string; message: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    listBrowserVoices().then((list) => {
      if (!cancelled) setBrowserVoices(list)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // providerId explicit selection, or else the default LLM preset's provider
  // — mirrors TtsSection's ttsProvider fallback above.
  const selectedProvider = providerId
    ? config.providers.find((p) => p.id === providerId)
    : (() => {
        const resolved = resolvePreset(config)
        return resolved ? config.providers.find((p) => p.id === resolved.providerId) : undefined
      })()

  const normalizedLang = normalizeLang(lang.trim())
  const sortedBrowserVoices = [...browserVoices].sort((a, b) => {
    const aMatch = normalizedLang && a.lang.toLowerCase().startsWith(normalizedLang) ? 0 : 1
    const bMatch = normalizedLang && b.lang.toLowerCase().startsWith(normalizedLang) ? 0 : 1
    if (aMatch !== bMatch) return aMatch - bMatch
    return a.name.localeCompare(b.name)
  })

  function resetForm() {
    setLang('')
    setModel('')
    setVoice('')
    setSpeed('')
    setVoiceURI('')
    setRate('')
  }

  function handleAdd(event: JSX.TargetedEvent<HTMLFormElement>) {
    event.preventDefault()
    const key = normalizeLang(lang.trim())
    if (!key) return
    let rule: TtsEngineRule
    if (engine === 'openai') {
      if (!model.trim()) return
      const speedNum = speed.trim() ? Number(speed.trim()) : undefined
      rule = {
        engine: 'openai',
        providerId: providerId || undefined,
        model: model.trim(),
        voice: voice.trim() || undefined,
        speed: speedNum !== undefined && Number.isFinite(speedNum) ? speedNum : undefined,
      }
    } else {
      if (!browserSupported) return
      const rateNum = rate.trim() ? Number(rate.trim()) : undefined
      rule = {
        engine: 'browser',
        voiceURI: voiceURI || undefined,
        rate: rateNum !== undefined && Number.isFinite(rateNum) ? rateNum : undefined,
      }
    }
    const next: TtsLangRulesV1 = { v: 1, rules: { ...rules.rules, [key]: rule } }
    saveTtsLangRules(next)
    setRules(next)
    resetForm()
  }

  function handleRemove(key: string) {
    const nextRules = { ...rules.rules }
    delete nextRules[key]
    const next: TtsLangRulesV1 = { v: 1, rules: nextRules }
    saveTtsLangRules(next)
    setRules(next)
  }

  async function handleTest(key: string, rule: TtsEngineRule) {
    setTestingLang(key)
    setTestError(null)
    try {
      if (rule.engine === 'openai') {
        const provider = rule.providerId
          ? config.providers.find((p) => p.id === rule.providerId)
          : (() => {
              const resolved = resolvePreset(config)
              return resolved ? config.providers.find((p) => p.id === resolved.providerId) : undefined
            })()
        if (!provider || !rule.model.trim()) {
          throw new Error(t('errors.llmNotConfigured'))
        }
        const blob = await synthesizeSpeech({
          connection: { baseUrl: provider.baseUrl, apiKey: provider.apiKey },
          model: rule.model,
          voice: rule.voice || 'alloy',
          text: t('settings.tts.testText'),
        })
        const url = URL.createObjectURL(blob)
        const audio = new Audio(url)
        audio.addEventListener('ended', () => URL.revokeObjectURL(url))
        await audio.play().catch(() => undefined)
        setTestingLang(null)
      } else {
        if (!browserSupported) {
          throw new Error(t('settings.ttsLang.browserUnsupported'))
        }
        createBrowserSpeech({
          text: t('settings.tts.testText'),
          lang: key === '*' ? undefined : key,
          voiceURI: rule.voiceURI,
          rate: rule.rate,
          onEnd: () => setTestingLang(null),
          onError: (err) => {
            setTestingLang(null)
            setTestError({ lang: key, message: err instanceof Error ? err.message : String(err) })
          },
        }).play()
      }
    } catch (err) {
      setTestingLang(null)
      setTestError({ lang: key, message: err instanceof Error ? err.message : String(err) })
    }
  }

  const entries = Object.entries(rules.rules)

  return (
    <div class="set-panel">
      <div class="set-panel__title">{t('settings.ttsLang.title')}</div>
      <p class="set-panel__hint">{t('settings.ttsLang.hint')}</p>

      {entries.length === 0 ? (
        <div class="set-empty">{t('settings.ttsLang.noRules')}</div>
      ) : (
        <div class="set-list">
          {entries.map(([key, rule]) => (
            <div class="set-item" key={key}>
              <div class="set-item__main">
                <div class="set-item__label">{key === '*' ? t('settings.ttsLang.anyLangLabel') : key}</div>
                <div class="set-item__detail">{summarizeTtsLangRule(rule)}</div>
              </div>
              <span class="set-badge">
                {rule.engine === 'openai' ? t('settings.ttsLang.engineOpenai') : t('settings.ttsLang.engineBrowser')}
              </span>
              <button type="button" class="set-btn" onClick={() => handleTest(key, rule)} disabled={testingLang === key}>
                {testingLang === key ? t('settings.tts.testing') : t('settings.tts.test')}
              </button>
              <button type="button" class="set-btn" onClick={() => handleRemove(key)}>
                {t('settings.ttsLang.remove')}
              </button>
            </div>
          ))}
        </div>
      )}
      {testError && (
        <div class="set-status-msg set-status-msg--error">{t('settings.tts.testError', { message: testError.message })}</div>
      )}

      <form onSubmit={handleAdd} class="set-section">
        <div class="set-grid">
          <div class="set-field">
            <label for="set-ttslang-lang">{t('settings.ttsLang.lang')}</label>
            <input
              id="set-ttslang-lang"
              type="text"
              value={lang}
              placeholder={t('settings.ttsLang.langPlaceholder')}
              onInput={(e) => setLang(e.currentTarget.value)}
            />
          </div>
          <div class="set-field">
            <label for="set-ttslang-engine">{t('settings.ttsLang.engine')}</label>
            <select
              id="set-ttslang-engine"
              value={engine}
              onChange={(e) => setEngine(e.currentTarget.value as 'openai' | 'browser')}
            >
              <option value="openai">{t('settings.ttsLang.engineOpenai')}</option>
              <option value="browser" disabled={!browserSupported}>
                {t('settings.ttsLang.engineBrowser')}
              </option>
            </select>
            {!browserSupported && <p class="set-note">{t('settings.ttsLang.browserUnsupported')}</p>}
          </div>

          {engine === 'openai' ? (
            <>
              <div class="set-field">
                <label for="set-ttslang-provider">{t('settings.tts.provider')}</label>
                <select id="set-ttslang-provider" value={providerId} onChange={(e) => setProviderId(e.currentTarget.value)}>
                  <option value="">{t('settings.tts.providerDefault')}</option>
                  {config.providers.map((provider) => (
                    <option value={provider.id} key={provider.id}>
                      {provider.label}
                    </option>
                  ))}
                </select>
              </div>
              <div class="set-field">
                <label for="set-ttslang-model">{t('settings.tts.model')}</label>
                <ModelField
                  id="set-ttslang-model"
                  value={model}
                  baseUrl={selectedProvider?.baseUrl ?? ''}
                  apiKey={selectedProvider?.apiKey ?? ''}
                  onChange={setModel}
                />
              </div>
              <div class="set-field">
                <label for="set-ttslang-voice">{t('settings.tts.voice')}</label>
                <VoiceField
                  id="set-ttslang-voice"
                  value={voice}
                  baseUrl={selectedProvider?.baseUrl ?? ''}
                  apiKey={selectedProvider?.apiKey ?? ''}
                  onChange={setVoice}
                />
              </div>
              <div class="set-field">
                <label for="set-ttslang-speed">{t('settings.tts.speed')}</label>
                <input
                  id="set-ttslang-speed"
                  type="text"
                  inputMode="decimal"
                  value={speed}
                  onInput={(e) => setSpeed(e.currentTarget.value)}
                />
              </div>
            </>
          ) : (
            <>
              <div class="set-field">
                <label for="set-ttslang-voiceuri">{t('settings.ttsLang.browserVoice')}</label>
                <select
                  id="set-ttslang-voiceuri"
                  value={voiceURI}
                  onChange={(e) => setVoiceURI(e.currentTarget.value)}
                  disabled={!browserSupported}
                >
                  <option value="">{t('settings.ttsLang.browserVoiceDefault')}</option>
                  {sortedBrowserVoices.map((v) => (
                    <option value={v.voiceURI} key={v.voiceURI}>
                      {v.name} ({v.lang})
                    </option>
                  ))}
                </select>
              </div>
              <div class="set-field">
                <label for="set-ttslang-rate">{t('settings.ttsLang.rate')}</label>
                <input
                  id="set-ttslang-rate"
                  type="text"
                  inputMode="decimal"
                  value={rate}
                  onInput={(e) => setRate(e.currentTarget.value)}
                  disabled={!browserSupported}
                />
              </div>
            </>
          )}
        </div>
        <button
          type="submit"
          class="set-btn set-btn--primary"
          disabled={!lang.trim() || (engine === 'openai' ? !model.trim() : !browserSupported)}
        >
          {t('settings.ttsLang.add')}
        </button>
      </form>
    </div>
  )
}

// ---------------------------------------------------------------------------
// AI Network

interface NetworkSectionProps {
  config: SharedLlmConfigV1
  onChange: (config: SharedLlmConfigV1) => void
}

function NetworkSection({ config, onChange }: NetworkSectionProps) {
  const [enabled, setEnabled] = useState(loadNetworkEnabled)
  const [roomId, setRoomId] = useState(config.network.roomId)
  useConsumerConnection(networkClient, { enabled, roomId })
  const status = useConsumerStatus(networkClient)
  const messages = getLocale() === 'ja' ? MESSAGES_JA : MESSAGES_EN

  function handleToggle() {
    const next = !enabled
    setEnabled(next)
    saveNetworkEnabled(next)
  }

  function handleSaveRoom(event: JSX.TargetedEvent<HTMLFormElement>) {
    event.preventDefault()
    const next = cloneConfig(config)
    next.network = { roomId: roomId.trim() }
    saveLlmConfig(next)
    onChange(next)
  }

  return (
    <div class="set-panel">
      <div class="set-panel__title">{t('settings.network.title')}</div>
      <label class="set-toggle-row">
        <input type="checkbox" checked={enabled} onChange={handleToggle} />
        <span>{t('settings.network.enable')}</span>
      </label>

      <form onSubmit={handleSaveRoom} class="set-section">
        <div class="set-field">
          <label for="set-network-room">{t('settings.network.roomId')}</label>
          <input
            id="set-network-room"
            type="text"
            value={roomId}
            placeholder={t('settings.network.roomIdPlaceholder')}
            onInput={(e) => setRoomId(e.currentTarget.value)}
          />
        </div>
        <button type="submit" class="set-btn set-btn--primary">
          {t('settings.network.save')}
        </button>
      </form>

      <div class="set-section">
        <ConsumerStatusIndicator status={status} messages={messages} variant="detailed" />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Vision judge (lib/evaluator/visionJudge.ts)

interface VisionSectionProps {
  config: SharedLlmConfigV1
}

function VisionSection({ config }: VisionSectionProps) {
  const [presetId, setPresetId] = useState(loadVisionPresetId)

  function handleChange(next: string) {
    setPresetId(next)
    saveVisionPresetId(next)
  }

  return (
    <div class="set-panel">
      <div class="set-panel__title">{t('settings.vision.title')}</div>
      <p class="set-panel__hint">{t('settings.vision.hint')}</p>
      <div class="set-field">
        <label for="set-vision-preset">{t('settings.vision.preset')}</label>
        {config.presets.length === 0 ? (
          <div class="set-empty">{t('settings.vision.noPresets')}</div>
        ) : (
          <select id="set-vision-preset" value={presetId} onChange={(e) => handleChange(e.currentTarget.value)}>
            <option value="">{t('settings.vision.presetNone')}</option>
            {config.presets.map((preset) => (
              <option value={preset.id} key={preset.id}>
                {preset.label}
              </option>
            ))}
          </select>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Language

function LocaleSection() {
  const [locale, setLocaleState] = useState<Locale>(getLocale())
  useEffect(() => subscribeLocale(setLocaleState), [])

  return (
    <div class="set-panel">
      <div class="set-panel__title">{t('settings.locale.title')}</div>
      <div class="set-segmented">
        <button
          type="button"
          class={`set-segmented__item${locale === 'en' ? ' is-active' : ''}`}
          onClick={() => setLocale('en')}
        >
          {t('settings.locale.en')}
        </button>
        <button
          type="button"
          class={`set-segmented__item${locale === 'ja' ? ' is-active' : ''}`}
          onClick={() => setLocale('ja')}
        >
          {t('settings.locale.ja')}
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

export default function SettingsTab(_props: SettingsTabProps) {
  const [config, setConfig] = useState<SharedLlmConfigV1>(() => loadLlmConfig() ?? emptyLlmConfig())

  useEffect(() => subscribeLlmConfig((next) => setConfig(next ?? emptyLlmConfig())), [])

  return (
    <div class="set-tab">
      <LlmSection config={config} onChange={setConfig} />
      <VisionSection config={config} />
      <TtsSection config={config} onChange={setConfig} />
      <TtsLangSection config={config} />
      <NetworkSection config={config} onChange={setConfig} />
      <LocaleSection />
    </div>
  )
}

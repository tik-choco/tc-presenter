import { useEffect, useState } from 'preact/hooks'
import { LlmSettings } from '@tik-choco/mistai/preact'
import { aiSettingsAdapter } from '../../lib/aiSettings'
import { getLocale, setLocale, subscribeLocale, type Locale } from '../../i18n'
import { aiText } from '../../i18n/ai'
import { requestOnboarding } from '../../lib/onboarding'
import { clampWorkerConcurrency, loadGenerateRolePrefs, saveGenerateRolePrefs } from './localPrefs'
import { emptyLlmConfig, loadLlmConfig, saveLlmConfig } from '../../lib/llmConfig'
import '@tik-choco/mistai/ui.css'
import './settings.css'
export default function SettingsTab() {
  const [locale, updateLocale] = useState(getLocale)
  const [prefs, setPrefs] = useState(loadGenerateRolePrefs)
  useEffect(() => subscribeLocale(updateLocale), [])
  return <div class="set-tab"><LlmSettings
    locale={locale}
    title={aiText('title')}
    localSettings={aiSettingsAdapter}
    tasks={(['default', 'vision', 'orchestrator', 'worker'] as const).map(id => ({ id, label: aiText(id), reasoning: true }))}
    voice={{ tts: {} }}
    headerSection={<div class="set-locale-row">
      <select aria-label={aiText('language')} value={locale} onChange={event => {
        const next = event.currentTarget.value as Locale
        setLocale(next)
        updateLocale(next)
      }}>
        <option value="en">English</option><option value="ja">日本語</option><option value="zh-CN">简体中文</option><option value="zh-TW">繁體中文</option>
      </select>
      <button type="button" onClick={() => requestOnboarding()}>{aiText('onboarding')}</button>
    </div>}
    extraSections={tab => tab === 'tasks' ? <div class="set-extra">
      <label>{aiText('concurrency')}<input type="number" min={1} max={8} value={prefs.workerConcurrency} onChange={event => {
        const next = { ...prefs, workerConcurrency: clampWorkerConcurrency(Number(event.currentTarget.value)) }
        setPrefs(next); saveGenerateRolePrefs(next)
      }} /></label>
      <label>{aiText('speed')}<input type="number" min={0.25} max={4} step={0.05} defaultValue={loadLlmConfig()?.tts?.speed ?? 1} onChange={event => {
        const speed = Number(event.currentTarget.value)
        if (!Number.isFinite(speed) || speed < 0.25 || speed > 4) return
        const config = loadLlmConfig() ?? emptyLlmConfig()
        config.tts = { model: '', ...config.tts, speed }
        saveLlmConfig(config)
      }} /></label>
    </div> : null}
  /></div>
}

import { useEffect, useState } from 'preact/hooks'
import { REASONING_EFFORT_OPTIONS, type LlmLocalSettings, type TaskModelV1 } from '@tik-choco/mistai/preact'
import { emptyLlmConfig, isModelRef, loadLlmConfig, presetIdToRef, providerKind } from './llmConfig'
import { safeSetItem } from './safeStorage'

export const AI_SETTINGS_KEY = 'tc-presenter:ai-settings-v2'
export type TaskId = 'default' | 'vision' | 'orchestrator' | 'worker'
const listeners = new Set<() => void>()

function read(key: string): any {
  try { return JSON.parse(localStorage.getItem(key) ?? 'null') } catch { return null }
}

function readText(key: string): string {
  try { return localStorage.getItem(key) ?? '' } catch { return '' }
}

function effort(value: unknown): TaskModelV1['reasoningEffort'] {
  return REASONING_EFFORT_OPTIONS.includes(value as TaskModelV1['reasoningEffort'])
    ? value as TaskModelV1['reasoningEffort'] : 'none'
}

export function loadAiSettings(): LlmLocalSettings {
  const config = loadLlmConfig() ?? emptyLlmConfig()
  const stored = read(AI_SETTINGS_KEY)
  if (stored?.tasks && stored?.roomProvide && Array.isArray(stored.recentModels)) return stored
  const roles = read('tc-presenter:generate-roles') ?? {}
  const legacyIds: Record<TaskId, string> = {
    default: config.defaultPresetId,
    vision: readText('tc-presenter:vision-preset-id'),
    orchestrator: roles.orchestratorPresetId ?? '',
    worker: roles.workerPresetId ?? '',
  }
  const tasks: LlmLocalSettings['tasks'] = {}
  for (const id of Object.keys(legacyIds) as TaskId[]) {
    const oldId = legacyIds[id]
    const preset = config.presets.find(p => p.id === oldId)
    tasks[id] = {
      ...(id !== 'default' ? { ref: presetIdToRef(config, oldId) } : {}),
      reasoningEffort: effort(roles[`${id}ReasoningEffort`] ?? preset?.reasoningEffort),
    }
  }
  const room = config.providers.find(p => p.baseUrl === `mist-network://${config.network.roomId.trim()}`)
  const sharedIds = read('tc-presenter:ai-network-provider-preset-ids') ?? []
  const shared = (Array.isArray(sharedIds) ? sharedIds : [])
    .map(id => presetIdToRef(config, id)).filter(isModelRef)
    .filter(ref => config.providers.some(p => p.id === ref.providerId && providerKind(p) === 'http'))
    .filter((ref, i, refs) => refs.findIndex(r => r.providerId === ref.providerId && r.model === ref.model) === i)
  const next: LlmLocalSettings = {
    tasks, recentModels: [],
    roomProvide: room ? { [room.id]: {
      enabled: readText('tc-presenter:ai-network-provider-enabled') === '1', shared,
    } } : {},
  }
  // This new record marks completion, including missing or retired preset ids.
  safeSetItem(AI_SETTINGS_KEY, JSON.stringify(next))
  return next
}

export function saveAiSettings(next: LlmLocalSettings): void {
  safeSetItem(AI_SETTINGS_KEY, JSON.stringify(next))
  listeners.forEach(cb => cb())
}

export function subscribeAiSettings(cb: () => void): () => void {
  listeners.add(cb)
  const onStorage = (event: StorageEvent) => { if (event.key === AI_SETTINGS_KEY) cb() }
  window.addEventListener('storage', onStorage)
  return () => { listeners.delete(cb); window.removeEventListener('storage', onStorage) }
}

export const aiSettingsAdapter = { get: loadAiSettings, set: saveAiSettings, subscribe: subscribeAiSettings }

export function useAiSettings() {
  const [settings, setSettings] = useState(loadAiSettings)
  useEffect(() => subscribeAiSettings(() => setSettings(loadAiSettings())), [])
  return settings
}

export function taskSettings(id: TaskId): TaskModelV1 {
  return loadAiSettings().tasks[id] ?? { reasoningEffort: 'none' }
}

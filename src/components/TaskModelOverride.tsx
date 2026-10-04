import { useState } from 'preact/hooks'
import { LLM_SETTINGS_MESSAGES, LlmSettings } from '@tik-choco/mistai/preact'
import '@tik-choco/mistai/ui.css'
import { resolveModel, type ModelRefV1, type SharedLlmConfigV1 } from '../lib/llmConfig'
import { loadAiSettings, saveAiSettings } from '../lib/aiSettings'
import { getLocale } from '../i18n'
import { aiText } from '../i18n/ai'

// Per-run choices use the public, localized settings dialog. Its adapter keeps
// the override in the editor while connection/share/history edits stay shared.
export function TaskModelOverride({ config, value, onChange, task }: {
  config: SharedLlmConfigV1
  value?: ModelRefV1 | null
  onChange(ref?: ModelRefV1 | null): void
  task: 'orchestrator' | 'worker'
}) {
  const [open, setOpen] = useState(false)
  const target = resolveModel(config, value ?? undefined)
  const selectedProvider = config.providers.find(p => p.id === value?.providerId)
  const model = value?.model ?? target?.model
  const provider = selectedProvider?.label ?? target?.label
  const warning = value && (!selectedProvider ? 'models-missing' : selectedProvider.enabled === false ? 'models-disabled' : '')
  return <div class="model-picker">
    <button type="button" class="edt-btn" data-task-override={task} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
      {model ? `${model} · ${provider ?? value?.providerId}` : aiText('model')}
    </button>
    {warning && <p class="model-warning" role="status">{LLM_SETTINGS_MESSAGES[getLocale()][warning]}</p>}
    {open && <LlmSettings
      title={aiText(task)} locale={getLocale()} initialTab="tasks"
      tasks={[{ id: task, label: aiText(task) }]}
      onClose={() => setOpen(false)}
      localSettings={{
        get: () => ({ ...loadAiSettings(), tasks: { [task]: { ref: value ?? undefined, reasoningEffort: 'none' } } }),
        set: next => {
          const current = loadAiSettings()
          saveAiSettings({ ...current, roomProvide: next.roomProvide, recentModels: next.recentModels })
          const ref = next.tasks[task]?.ref
          if (JSON.stringify(ref) !== JSON.stringify(value ?? undefined)) {
            onChange(ref ?? null)
            setOpen(false)
          }
        },
      }}
    />}
  </div>
}

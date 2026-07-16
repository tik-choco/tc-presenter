// First-run wizard shown by app.tsx as a modal overlay: welcome -> LLM
// connection -> feature tour. Every step is skippable and closing at any
// point counts as "done" — the caller (lib/onboarding.ts's markOnboardingDone)
// owns that flag via `onClose`, not this component.
import { useState } from 'preact/hooks'
import { Sparkles, Cpu, Check, X, ArrowLeft, ArrowRight, Plug, FileText, WandSparkles, Presentation, Settings } from 'lucide-preact'
import { t } from '../i18n'
import {
  emptyLlmConfig,
  ensureProvider,
  ensurePreset,
  loadLlmConfig,
  resolvePreset,
  saveLlmConfig,
  type ResolvedLlmTargetV1,
} from '../lib/llmConfig'
import { requestApiChatCompletionStreaming } from '../lib/llm'
import './onboarding.css'

const STEP_COUNT = 3

interface LlmDraft {
  baseUrl: string
  apiKey: string
  model: string
}

type TestState = { phase: 'idle' } | { phase: 'busy' } | { phase: 'ok' } | { phase: 'error'; message: string }

function inputValue(event: Event): string {
  return (event.target as HTMLInputElement).value
}

export function Onboarding(props: { onClose: () => void }) {
  const [step, setStep] = useState(0)

  // LLM draft starts from the shared config's current default preset so
  // re-running the wizard shows (and edits) the real current connection
  // instead of blank fields.
  const [llm, setLlm] = useState<LlmDraft>(() => {
    const target = resolvePreset(loadLlmConfig() ?? emptyLlmConfig())
    return {
      baseUrl: target?.baseUrl ?? '',
      apiKey: target?.apiKey ?? '',
      model: target?.model ?? '',
    }
  })
  const [testState, setTestState] = useState<TestState>({ phase: 'idle' })

  function updateLlm(patch: Partial<LlmDraft>) {
    setLlm((prev) => ({ ...prev, ...patch }))
    // Edited connection values invalidate a previous test result.
    setTestState({ phase: 'idle' })
  }

  /** Persists the draft into the default preset: edits it in place if one
   * already exists, otherwise creates a provider+preset and sets it as
   * default. Mirrors tc-town's Onboarding.tsx saveLlmDraft. */
  function saveLlmDraft() {
    const cfg = loadLlmConfig() ?? emptyLlmConfig()
    const providerId = ensureProvider(cfg, { baseUrl: llm.baseUrl, apiKey: llm.apiKey })
    const existingDefault = cfg.presets.find((p) => p.id === cfg.defaultPresetId)
    if (existingDefault) {
      existingDefault.providerId = providerId
      existingDefault.model = llm.model.trim()
    } else {
      cfg.defaultPresetId = ensurePreset(cfg, { providerId, model: llm.model.trim() })
    }
    saveLlmConfig(cfg)
  }

  async function handleTest() {
    if (testState.phase === 'busy') return
    setTestState({ phase: 'busy' })
    // Tests the draft directly (before it's saved) so the user can verify a
    // connection before committing it.
    const target: ResolvedLlmTargetV1 = {
      presetId: '',
      providerId: '',
      label: '',
      baseUrl: llm.baseUrl,
      apiKey: llm.apiKey,
      model: llm.model,
    }
    try {
      await requestApiChatCompletionStreaming(
        target,
        [{ role: 'user', content: 'Connection test. Reply with just "OK".' }],
        undefined,
        () => {},
      )
      setTestState({ phase: 'ok' })
    } catch (error) {
      setTestState({ phase: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  function handleLlmNext() {
    saveLlmDraft()
    setStep(2)
  }

  return (
    <div class="ob-overlay">
      <div class="ob-card" role="dialog" aria-modal="true" aria-label={t('onboarding.welcome.title')}>
        <button class="ob-close" type="button" onClick={props.onClose} title={t('common.close')} aria-label={t('common.close')}>
          <X size={18} />
        </button>

        {step === 0 && (
          <div class="ob-body">
            <div class="ob-hero">
              <Sparkles size={36} />
            </div>
            <h2 class="ob-title">{t('onboarding.welcome.title')}</h2>
            <p class="ob-text">{t('onboarding.welcome.body1')}</p>
            <p class="ob-text">{t('onboarding.welcome.body2')}</p>
          </div>
        )}

        {step === 1 && (
          <div class="ob-body">
            <div class="ob-step-head">
              <Cpu size={22} />
              <h2 class="ob-title">{t('onboarding.llm.title')}</h2>
            </div>
            <p class="ob-text">{t('onboarding.llm.body')}</p>

            <div class="ob-field">
              <label class="ob-label">{t('onboarding.llm.baseUrl')}</label>
              <input
                class="ob-input"
                type="text"
                placeholder="https://api.openai.com/v1"
                value={llm.baseUrl}
                onInput={(e) => updateLlm({ baseUrl: inputValue(e) })}
              />
            </div>
            <div class="ob-field">
              <label class="ob-label">{t('onboarding.llm.apiKey')}</label>
              <input
                class="ob-input"
                type="password"
                placeholder="sk-..."
                value={llm.apiKey}
                onInput={(e) => updateLlm({ apiKey: inputValue(e) })}
              />
            </div>
            <div class="ob-field">
              <label class="ob-label">{t('onboarding.llm.model')}</label>
              <input
                class="ob-input"
                type="text"
                placeholder="gpt-4o-mini"
                value={llm.model}
                onInput={(e) => updateLlm({ model: inputValue(e) })}
              />
            </div>

            <div class="ob-test-row">
              <button
                class="ob-btn"
                type="button"
                onClick={() => void handleTest()}
                disabled={testState.phase === 'busy' || !llm.baseUrl.trim()}
              >
                {testState.phase === 'busy' ? <span class="ob-spinner" /> : <Plug size={16} />}
                {testState.phase === 'busy' ? t('onboarding.llm.testing') : t('onboarding.llm.test')}
              </button>
              {testState.phase === 'ok' && (
                <span class="ob-test-ok">
                  <Check size={16} />
                  {t('onboarding.llm.testOk')}
                </span>
              )}
            </div>
            {testState.phase === 'error' && <p class="ob-error">{t('onboarding.llm.testError', { message: testState.message })}</p>}
          </div>
        )}

        {step === 2 && (
          <div class="ob-body">
            <div class="ob-step-head">
              <Check size={22} />
              <h2 class="ob-title">{t('onboarding.features.title')}</h2>
            </div>
            <p class="ob-text">{t('onboarding.features.body')}</p>
            <ul class="ob-feature-list">
              <li>
                <FileText size={16} />
                <span>{t('onboarding.features.sources')}</span>
              </li>
              <li>
                <WandSparkles size={16} />
                <span>{t('onboarding.features.editor')}</span>
              </li>
              <li>
                <Presentation size={16} />
                <span>{t('onboarding.features.present')}</span>
              </li>
              <li>
                <Settings size={16} />
                <span>{t('onboarding.features.settings')}</span>
              </li>
            </ul>
            <p class="ob-text ob-text-subtle">{t('onboarding.features.footer')}</p>
          </div>
        )}

        <footer class="ob-footer">
          <div class="ob-dots" aria-hidden="true">
            {Array.from({ length: STEP_COUNT }, (_, i) => (
              <span key={i} class={'ob-dot' + (i === step ? ' is-active' : '')} />
            ))}
          </div>
          <div class="ob-footer-actions">
            {step > 0 && step < 2 && (
              <button class="ob-btn" type="button" onClick={() => setStep(step - 1)}>
                <ArrowLeft size={16} />
                {t('onboarding.nav.back')}
              </button>
            )}
            {step === 0 && (
              <button class="ob-btn ob-btn-accent" type="button" onClick={() => setStep(1)}>
                {t('onboarding.nav.start')}
                <ArrowRight size={16} />
              </button>
            )}
            {step === 1 && (
              <button class="ob-btn ob-btn-accent" type="button" onClick={handleLlmNext}>
                {t('onboarding.nav.next')}
                <ArrowRight size={16} />
              </button>
            )}
            {step === 2 && (
              <button class="ob-btn ob-btn-accent" type="button" onClick={props.onClose}>
                <Check size={16} />
                {t('onboarding.nav.done')}
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  )
}

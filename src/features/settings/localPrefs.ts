// tc-presenter-local UI preferences that don't belong in the co-owned
// tc-shared-llm-config-v1 record (lib/llmConfig.ts) because they aren't
// shared across the tik-choco app family — just this app's "should the AI
// Network consumer be active" toggle. `network.roomId` itself *does* live in
// the shared config (see llmConfig.ts's SharedLlmConfigV1.network); this is
// only the on/off switch layered on top of it.

const AI_NETWORK_ENABLED_KEY = 'tc-presenter:ai-network-enabled'

export function loadNetworkEnabled(): boolean {
  try {
    return localStorage.getItem(AI_NETWORK_ENABLED_KEY) === '1'
  } catch {
    return false
  }
}

export function saveNetworkEnabled(enabled: boolean): void {
  try {
    if (enabled) localStorage.setItem(AI_NETWORK_ENABLED_KEY, '1')
    else localStorage.removeItem(AI_NETWORK_ENABLED_KEY)
  } catch {
    // best-effort persistence only
  }
}

// tc-shared-llm-config-v1 preset id to use for the vision judge (lib/
// evaluator/visionJudge.ts). Local, not shared with the rest of the
// tik-choco app family (unlike the presets themselves) — this is purely
// "which of my already-configured presets is vision-capable", set once in
// Settings so the editor's generate form can turn useVisionJudge on "for
// free" without asking the user to pick a preset every time (task brief:
// "「LLM設定するだけで」動くこと").
const VISION_PRESET_ID_KEY = 'tc-presenter:vision-preset-id'

export function loadVisionPresetId(): string {
  try {
    return localStorage.getItem(VISION_PRESET_ID_KEY) ?? ''
  } catch {
    return ''
  }
}

export function saveVisionPresetId(presetId: string): void {
  try {
    if (presetId) localStorage.setItem(VISION_PRESET_ID_KEY, presetId)
    else localStorage.removeItem(VISION_PRESET_ID_KEY)
  } catch {
    // best-effort persistence only
  }
}

// Orchestrator/worker role defaults for the generate pipeline (types.ts's
// GenerateOptions.presetId / workerPresetId / workerConcurrency). Like
// visionPresetId above, this is purely "which of my already-configured
// shared presets plays which role" — the presets themselves live in the
// co-owned tc-shared-llm-config-v1 record. Set once in Settings; the
// editor's generate form seeds its pickers from this so a run needs zero
// per-run model configuration (and can still override per-run).
const GENERATE_ROLES_KEY = 'tc-presenter:generate-roles'

export interface GenerateRolePrefs {
  /** Preset for the planning/orchestrator calls (script, evaluation, batch
   * refine). "" = the shared config's defaultPresetId. */
  orchestratorPresetId: string
  /** Preset for the fan-out worker calls (per-segment slides, per-slide
   * refine). "" = same as the orchestrator. */
  workerPresetId: string
  /** How many segment-slide workers run concurrently (1 = sequential).
   * Clamped to generateDeck.ts's own 1..8 bound. */
  workerConcurrency: number
}

export const DEFAULT_GENERATE_ROLE_PREFS: GenerateRolePrefs = {
  orchestratorPresetId: '',
  workerPresetId: '',
  workerConcurrency: 1,
}

export function clampWorkerConcurrency(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.max(1, Math.min(8, Math.trunc(value)))
}

export function loadGenerateRolePrefs(): GenerateRolePrefs {
  try {
    const raw = localStorage.getItem(GENERATE_ROLES_KEY)
    if (!raw) return { ...DEFAULT_GENERATE_ROLE_PREFS }
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return { ...DEFAULT_GENERATE_ROLE_PREFS }
    const record = parsed as Record<string, unknown>
    return {
      orchestratorPresetId: typeof record.orchestratorPresetId === 'string' ? record.orchestratorPresetId : '',
      workerPresetId: typeof record.workerPresetId === 'string' ? record.workerPresetId : '',
      workerConcurrency: clampWorkerConcurrency(typeof record.workerConcurrency === 'number' ? record.workerConcurrency : 1),
    }
  } catch {
    return { ...DEFAULT_GENERATE_ROLE_PREFS }
  }
}

export function saveGenerateRolePrefs(prefs: GenerateRolePrefs): void {
  try {
    localStorage.setItem(
      GENERATE_ROLES_KEY,
      JSON.stringify({ ...prefs, workerConcurrency: clampWorkerConcurrency(prefs.workerConcurrency) }),
    )
  } catch {
    // best-effort persistence only
  }
}

// PresentPlayer's speakerNotes caption overlay toggle (features/present/
// PresentPlayer.tsx). Off by default — presenting already shows the slide
// full-screen, so captions are an opt-in accessibility/reference aid.
const CAPTIONS_ENABLED_KEY = 'tc-presenter:captions-enabled'

export function loadCaptionsEnabled(): boolean {
  try {
    return localStorage.getItem(CAPTIONS_ENABLED_KEY) === '1'
  } catch {
    return false
  }
}

export function saveCaptionsEnabled(enabled: boolean): void {
  try {
    if (enabled) localStorage.setItem(CAPTIONS_ENABLED_KEY, '1')
    else localStorage.removeItem(CAPTIONS_ENABLED_KEY)
  } catch {
    // best-effort persistence only
  }
}

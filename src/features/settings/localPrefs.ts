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

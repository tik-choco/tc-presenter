// Shared storage and resolution belong to mistai; migrate before callers read.
export * from '@tik-choco/mistai/llm-config'
import { loadLlmConfig as loadShared, migrateSharedLlmConfig, saveLlmConfig } from '@tik-choco/mistai/llm-config'
export function loadLlmConfig() {
  const config = loadShared()
  if (config && migrateSharedLlmConfig(config).changed) saveLlmConfig(config)
  return config
}

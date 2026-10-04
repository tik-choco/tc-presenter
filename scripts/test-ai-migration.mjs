import fs from 'node:fs'
import assert from 'node:assert/strict'
import ts from 'typescript'
import { migrateSharedLlmConfig, resolveModel, resolveVoice } from '@tik-choco/mistai/llm-config'

const storage = new Map()
globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) }
globalThis.window = new EventTarget()
function moduleUrl(path) {
  let source = fs.readFileSync(new URL(path, import.meta.url), 'utf8')
  source = source.replace(/from ['"]([^'"]+)['"]/g, (_, spec) => {
    const url = spec.startsWith('.') ? moduleUrl('../src/lib/' + spec.slice(2) + '.ts') : import.meta.resolve(spec)
    return 'from ' + JSON.stringify(url)
  })
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  return 'data:text/javascript;base64,' + Buffer.from(js).toString('base64')
}
const { loadAiSettings, saveAiSettings } = await import(moduleUrl('../src/lib/aiSettings.ts'))
const config = { v: 1, providers: [
  { id: 'http', label: 'HTTP', baseUrl: 'https://example.test/v1', apiKey: '', models: Array.from({ length: 300 }, (_, i) => 'model-' + i), modelsFetchedAt: '2026-01-01T00:00:00Z' },
  { id: 'disabled', label: 'Disabled', baseUrl: 'https://disabled.test/v1', apiKey: '', enabled: false },
  { id: 'mirror', label: 'Old room', baseUrl: 'mist-network://old', apiKey: '' },
], presets: [
  { id: 'default', label: 'Default', providerId: 'http', model: 'model-10', temperature: 0.7, reasoningEffort: 'high' },
  { id: 'task', label: 'Task', providerId: 'http', model: 'model-42', reasoningEffort: 'low' },
  { id: 'disabled-task', label: 'Disabled', providerId: 'disabled', model: 'hidden' },
  { id: 'mirror-task', label: 'Mirror', providerId: 'mirror', model: 'retired' },
], defaultPresetId: 'default', network: { roomId: 'team' }, updatedAt: '2026-01-01T00:00:00Z', tts: { providerId: 'disabled', model: 'speech' } }
const legacy = structuredClone(config)
localStorage.setItem('tc-shared-llm-config-v1', JSON.stringify(config))
localStorage.setItem('tc-presenter:generate-roles', JSON.stringify({ orchestratorPresetId: 'task', workerPresetId: 'disabled-task', orchestratorReasoningEffort: 'minimal', workerConcurrency: 3 }))
localStorage.setItem('tc-presenter:vision-preset-id', 'mirror-task')
localStorage.setItem('tc-presenter:ai-network-provider-enabled', '1')
localStorage.setItem('tc-presenter:ai-network-provider-preset-ids', JSON.stringify(['default', 'mirror-task', 'default']))
const local = loadAiSettings()
const migrated = JSON.parse(localStorage.getItem('tc-shared-llm-config-v1'))
assert.deepEqual(migrated.defaultModel, { providerId: 'http', model: 'model-10' })
for (const key of ['presets', 'defaultPresetId', 'network']) assert.deepEqual(migrated[key], legacy[key])
assert.equal(migrated.providers[0].models.length, 300)
assert.equal(migrateSharedLlmConfig(migrated).changed, false)
assert.deepEqual(local.tasks.orchestrator, { ref: { providerId: 'http', model: 'model-42' }, reasoningEffort: 'minimal' })
assert.deepEqual(local.tasks.worker.ref, { providerId: 'disabled', model: 'hidden' })
assert.equal(local.tasks.vision.ref, undefined)
const room = migrated.providers.find(p => p.baseUrl === 'mist-network://team')
assert.deepEqual(local.roomProvide[room.id], { enabled: true, shared: [{ providerId: 'http', model: 'model-10' }] })
assert.deepEqual(resolveModel(migrated, local.tasks.worker.ref)?.model, 'model-10')
assert.equal(resolveModel({ ...migrated, defaultModel: undefined }, local.tasks.worker.ref), null)
assert.deepEqual(local.tasks.worker.ref, { providerId: 'disabled', model: 'hidden' })
assert.equal(resolveVoice(migrated, 'tts')?.providerId, 'http')
local.tasks.orchestrator.ref = { providerId: 'http', model: 'model-299' }
saveAiSettings(local)
const before = [...storage.entries()]
assert.deepEqual(loadAiSettings(), JSON.parse(JSON.stringify(local)))
assert.deepEqual([...storage.entries()], before)
console.log('AI migration: legacy preservation, effort, disabled fallback, room shares and idempotence passed')

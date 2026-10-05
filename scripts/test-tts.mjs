import fs from 'node:fs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import ts from 'typescript'
import * as mistai from '@tik-choco/mistai'
import * as llmConfig from '@tik-choco/mistai/llm-config'

const source = fs.readFileSync(new URL('../src/lib/tts.ts', import.meta.url), 'utf8')
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
function fixture(t, room = false) {
  const config = { ...llmConfig.emptyLlmConfig(), providers: [{ id: 'voice', label: 'Voice', baseUrl: room ? 'mist-network://team' : 'https://example.test/v1', apiKey: '' }], tts: { providerId: 'voice', model: 'speech', speed: 1.5 } }
  const calls = []
  const originalFetch = globalThis.fetch, originalStorage = globalThis.localStorage
  globalThis.localStorage = { getItem: () => JSON.stringify(config) }
  globalThis.fetch = async (_url, init) => { calls.push(JSON.parse(init.body)); return new Response('audio', { headers: { 'Content-Type': 'audio/ogg' } }) }
  t.after(() => { globalThis.fetch = originalFetch; globalThis.localStorage = originalStorage })
  const roomCalls = [], rooms = { requestRoomTts: async (...args) => { roomCalls.push(args); return new Blob(['audio'], { type: 'audio/ogg' }) } }
  const exports = {}
  new Function('require', 'exports', js)(spec => spec === '@tik-choco/mistai' ? mistai : spec === './llmConfig' ? llmConfig : { rooms }, exports)
  return { call: params => exports.synthesizeSpeech({ connection: config.providers[0], model: 'speech', voice: 'saved', text: 'Hello', ...params }), calls, roomCalls }
}
test('HTTP TTS uses shared speed and keeps the actual MIME without an implicit format', async t => {
  const f = fixture(t)
  assert.equal((await f.call()).type, 'audio/ogg')
  assert.equal(f.calls[0].speed, 1.5)
  assert.equal('response_format' in f.calls[0], false)
})
test('HTTP TTS caller speed and format override the shared settings', async t => {
  const f = fixture(t)
  assert.equal((await f.call({ speed: 0.75, responseFormat: 'wav' })).type, 'audio/ogg')
  assert.equal(f.calls[0].speed, 0.75)
  assert.equal(f.calls[0].response_format, 'wav')
})
test('HTTP TTS ignores invalid hints independently', async t => {
  const f = fixture(t)
  await f.call({ speed: 5, responseFormat: 'wav' })
  assert.equal('speed' in f.calls[0], false)
  assert.equal(f.calls[0].response_format, 'wav')
  await f.call({ speed: 0.25, responseFormat: 'unknown' })
  assert.equal(f.calls[1].speed, 0.25)
  assert.equal('response_format' in f.calls[1], false)
})
test('room TTS delegates defaults and forwards caller hints, trusting the real MIME', async t => {
  const f = fixture(t, true)
  assert.equal((await f.call()).type, 'audio/ogg')
  assert.deepEqual(f.roomCalls[0], ['team', { text: 'Hello', model: 'speech', voice: 'saved' }])
  await f.call({ speed: 0.75, responseFormat: 'wav' })
  assert.deepEqual(f.roomCalls[1], ['team', { text: 'Hello', model: 'speech', voice: 'saved', speed: 0.75, responseFormat: 'wav' }])
  assert.equal(f.calls.length, 0)
})

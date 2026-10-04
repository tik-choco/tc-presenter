import fs from 'node:fs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import ts from 'typescript'
import * as mistai from '@tik-choco/mistai'
import * as llmConfig from '@tik-choco/mistai/llm-config'

// Load the app helper with an in-memory room transport and saved task settings.
const source = fs.readFileSync(new URL('../src/lib/llm.ts', import.meta.url), 'utf8')
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText

function fixture(t, reasoningEffort = 'high') {
  const wire = [], chatCalls = [], tunnelCalls = [], joined = []
  const firstDelta = Promise.withResolvers()
  let finishChat
  const rooms = mistai.createRoomConsumers(() => {
    let receive
    const reply = message => receive(mistai.EVENT_RAW, 'provider', mistai.encode({ v: 1, ...message }))
    return {
      async init() {},
      onEvent(handler) { receive = handler },
      joinRoom(room) {
        joined.push(room)
        queueMicrotask(() => reply({ type: 'provider_hello', models: ['test-model'], services: ['chat', 'oai'] }))
      },
      leaveRoom() {},
      sendMessage(_to, bytes) {
        const message = mistai.decode(bytes)
        wire.push(message)
        if (message.type === 'consumer_hello') {
          queueMicrotask(() => reply({ type: 'provider_hello', models: ['test-model'], services: ['chat', 'oai'] }))
        } else if (message.type === 'llm_request') {
          finishChat = () => {
            reply({ type: 'llm_response_chunk', id: message.id, seq: 1, delta: ' world' })
            reply({ type: 'llm_response_done', id: message.id, content: 'Hello world' })
          }
          queueMicrotask(() => {
            reply({ type: 'llm_response_chunk', id: message.id, seq: 0, delta: 'Hello' })
            firstDelta.resolve()
          })
        } else if (message.type === 'oai_request' && message.last) {
          queueMicrotask(() => reply({
            type: 'oai_response', id: message.id, seq: 0, last: true, status: 200, contentType: 'application/json',
            data: Buffer.from(JSON.stringify({ choices: [{ message: { content: 'Image text' } }] })).toString('base64'),
          }))
        }
      },
    }
  }, { requestTimeoutMs: 1000, providerWaitTimeoutMs: 1000 })
  t.after(() => rooms.disconnectRoom('team'))
  const chat = rooms.requestRoomChat, tunnel = rooms.requestRoomOpenAi
  rooms.requestRoomChat = (...args) => { chatCalls.push(args); return chat(...args) }
  rooms.requestRoomOpenAi = (...args) => { tunnelCalls.push(args); return tunnel(...args) }
  const config = {
    ...llmConfig.emptyLlmConfig(),
    providers: [
      { id: 'room', label: 'Room', baseUrl: 'mist-network://team', apiKey: '' },
      { id: 'http', label: 'HTTP', baseUrl: 'https://example.test/v1', apiKey: '' },
    ],
    defaultModel: { providerId: 'room', model: 'test-model' },
  }
  const tasks = { default: { reasoningEffort: 'medium' }, worker: { reasoningEffort }, vision: { reasoningEffort: 'low' } }
  const dependencies = {
    '@tik-choco/mistai': mistai,
    './llmConfig': { ...llmConfig, loadLlmConfig: () => config },
    './aiNetwork': { rooms, localizeNetworkError: error => error.message },
    './aiSettings': { taskSettings: task => tasks[task] },
    '../i18n': { t: key => key },
  }
  const exports = {}
  new Function('require', 'exports', js)(specifier => {
    assert.ok(dependencies[specifier], 'Unexpected dependency: ' + specifier)
    return dependencies[specifier]
  }, exports)
  return { ...exports, wire, chatCalls, tunnelCalls, joined, firstDelta: firstDelta.promise, finishChat: () => finishChat() }
}

for (const effort of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
  test('room chat streams task effort ' + effort + ' through requestRoomChat and llm_request', { timeout: 3000 }, async t => {
    const f = fixture(t, effort)
    const deltas = []
    const onDelta = (delta, full) => deltas.push([delta, full])
    const messages = [
      { role: 'system', content: 'Answer briefly.' },
      { role: 'user', content: [{ type: 'text', text: 'Say ' }, { type: 'text', text: 'hello.' }] },
    ]
    let completed = false
    const pending = f.requestChatCompletion(messages, { task: 'worker', onDelta })
    pending.then(() => { completed = true })
    await f.firstDelta
    assert.equal(completed, false)
    assert.deepEqual(deltas, [['Hello', 'Hello']])
    assert.equal(f.chatCalls.length, 1)
    assert.equal(f.chatCalls[0][0], 'team')
    assert.deepEqual(f.chatCalls[0][2], { model: 'test-model', reasoningEffort: effort, onDelta })
    const request = f.wire.find(message => message.type === 'llm_request')
    assert.equal(request.reasoning_effort, effort)
    assert.equal(request.model, 'test-model')
    assert.deepEqual(request.messages, [messages[0], { role: 'user', content: 'Say hello.' }])
    assert.equal('temperature' in request, false)
    assert.equal(f.tunnelCalls.length, 0)
    assert.equal(f.wire.some(message => message.type === 'oai_request'), false)
    assert.deepEqual(f.joined, ['team'])
    f.finishChat()
    assert.equal(await pending, 'Hello world')
    assert.deepEqual(deltas, [['Hello', 'Hello'], [' world', 'Hello world']])
  })
}

test('room vision/OCR preserves image parts through the OpenAI tunnel', { timeout: 3000 }, async t => {
  const f = fixture(t)
  const messages = [{ role: 'user', content: [
    { type: 'text', text: 'Read the text in this image.' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,aW1hZ2U=' } },
  ] }]
  const deltas = []
  assert.equal(await f.requestChatCompletion(messages, { task: 'vision', onDelta: (...args) => deltas.push(args) }), 'Image text')
  assert.equal(f.chatCalls.length, 0)
  assert.equal(f.wire.some(message => message.type === 'llm_request'), false)
  assert.equal(f.tunnelCalls.length, 1)
  const [room, request] = f.tunnelCalls[0]
  assert.equal(room, 'team')
  assert.equal(request.path, '/chat/completions')
  const body = JSON.parse(request.body)
  assert.deepEqual(body, { model: 'test-model', messages, stream: false, reasoning_effort: 'low' })
  const chunks = f.wire.filter(message => message.type === 'oai_request')
  assert.equal(chunks[0].path, '/chat/completions')
  assert.deepEqual(JSON.parse(Buffer.concat(chunks.map(chunk => Buffer.from(chunk.data, 'base64'))).toString()), body)
  assert.deepEqual(deltas, [['Image text', 'Image text']])
})

test('HTTP chat and onboarding retain reasoning_effort and omit temperature', async t => {
  const f = fixture(t, 'max')
  const bodies = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'https://example.test/v1/chat/completions')
    bodies.push(JSON.parse(init.body))
    return Response.json({ choices: [{ message: { content: 'HTTP reply' } }] })
  })
  const messages = [{ role: 'user', content: 'Hello' }]
  const deltas = []
  assert.equal(await f.requestChatCompletion(messages, {
    task: 'worker', modelRef: { providerId: 'http', model: 'http-model' }, onDelta: (...args) => deltas.push(args),
  }), 'HTTP reply')
  assert.deepEqual(deltas, [['HTTP reply', 'HTTP reply']])
  await f.requestApiChatCompletionStreaming({ baseUrl: 'https://example.test/v1', apiKey: '', model: 'draft-model' }, messages, undefined, () => {})
  assert.deepEqual(bodies.map(body => body.reasoning_effort), ['max', 'medium'])
  assert.ok(bodies.every(body => !('temperature' in body) && body.stream === true))
  assert.equal(f.chatCalls.length + f.tunnelCalls.length, 0)
})

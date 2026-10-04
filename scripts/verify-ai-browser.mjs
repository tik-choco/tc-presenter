import fs from 'node:fs/promises'
import assert from 'node:assert/strict'

const W = process.argv[2]
assert.ok(W, 'Pass rollout workspace path')
const targets = await (await fetch('http://127.0.0.1:9308/json/list')).json()
const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl)
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
let sequence = 0
const pending = new Map(), errors = [], consoleErrors = []
ws.onmessage = event => {
  const message = JSON.parse(event.data)
  if (message.id) {
    const request = pending.get(message.id); pending.delete(message.id)
    if (message.error) request.reject(message.error); else request.resolve(message.result)
  } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
  else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') consoleErrors.push(message.params.args.map(a => a.value ?? a.description))
}
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
  return result.result.value
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(expression) {
  for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await delay(100) }
  throw new Error('Timed out: ' + expression)
}
async function shot(name) {
  await delay(350)
  const result = await send('Page.captureScreenshot', { format: 'png' })
  await fs.writeFile(W + '/shots/p2-presenter-' + name + '.png', Buffer.from(result.data, 'base64'))
}
const seed = () => {
  if (location.port !== '5308') return
  window.__calls = []
  const original = window.fetch.bind(window)
  window.fetch = async (input, init) => {
    const url = String(input)
    if (url.includes('example.test')) {
      window.__calls.push({ url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null })
      if (url.endsWith('/models')) return new Response(JSON.stringify({ data: Array.from({ length: 300 }, (_, i) => ({ id: 'model-' + String(i).padStart(3, '0') })) }), { headers: { 'Content-Type': 'application/json' } })
      if (url.includes('voices')) return new Response(JSON.stringify({ voices: [{ id: 'voice-one' }] }), { headers: { 'Content-Type': 'application/json' } })
      if (url.endsWith('/chat/completions')) return new Response(JSON.stringify({ choices: [{ message: { content: 'Stub OK' } }] }), { headers: { 'Content-Type': 'application/json' } })
      if (url.endsWith('/audio/speech')) return new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'audio/mpeg' } })
    }
    return original(input, init)
  }
  if (localStorage.getItem('p2-presenter-seeded')) return
  localStorage.clear(); localStorage.setItem('p2-presenter-seeded', '1')
  localStorage.setItem('tc-shared-llm-config-v1', JSON.stringify({ v: 1, providers: [
    { id: 'http', label: 'Presenter HTTP', baseUrl: 'https://example.test/v1', apiKey: 'stub', models: Array.from({ length: 300 }, (_, i) => 'model-' + String(i).padStart(3, '0')) },
    { id: 'disabled', label: 'Disabled connection', baseUrl: 'https://disabled.example.test/v1', apiKey: '', enabled: false, models: ['hidden-model'] },
  ], presets: [
    { id: 'legacy-default', label: 'Old default', providerId: 'http', model: 'model-010', temperature: 0.7, reasoningEffort: 'high' },
    { id: 'legacy-task', label: 'Old task', providerId: 'http', model: 'model-042', reasoningEffort: 'low' },
    { id: 'legacy-disabled', label: 'Old disabled', providerId: 'disabled', model: 'hidden-model' },
  ], defaultPresetId: 'legacy-default', network: { roomId: 'presenter-team' }, tts: { providerId: 'http', model: 'model-020', voice: 'voice-one', speed: 1.1 }, updatedAt: '2026-01-01T00:00:00.000Z' }))
  localStorage.setItem('tc-presenter:generate-roles', JSON.stringify({ orchestratorPresetId: 'legacy-task', workerPresetId: 'legacy-disabled', orchestratorReasoningEffort: 'minimal', workerConcurrency: 3, pipelineMode: 'plan_fanout' }))
  localStorage.setItem('tc-presenter:vision-preset-id', 'legacy-task')
  localStorage.setItem('tc-presenter:ai-network-provider-enabled', '1')
  localStorage.setItem('tc-presenter:ai-network-provider-preset-ids', JSON.stringify(['legacy-default']))
  localStorage.setItem('tc-presenter:onboarding-done', '1')
  localStorage.setItem('tc-presenter-locale', 'ja')
}
try {
  await fs.mkdir(W + '/shots', { recursive: true })
  await send('Page.enable'); await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 940, deviceScaleFactor: 1, mobile: false })
  await send('Page.addScriptToEvaluateOnNewDocument', { source: '(' + seed.toString() + ')()' })
  await send('Storage.clearDataForOrigin', { origin: 'http://localhost:5308', storageTypes: 'local_storage' })
  await send('Page.navigate', { url: 'http://localhost:5308/' })
  await until('!!document.querySelector(".app-shell")')
  await evaluate('document.querySelectorAll(".tab-bar button")[3].click()')
  await until('!!document.querySelector(".provider-card")')
  const migrated = await evaluate('({config:JSON.parse(localStorage.getItem("tc-shared-llm-config-v1")),local:JSON.parse(localStorage.getItem("tc-presenter:ai-settings-v2"))})')
  assert.deepEqual(migrated.config.defaultModel, { providerId: 'http', model: 'model-010' })
  assert.equal(migrated.config.presets[0].temperature, 0.7)
  assert.equal(migrated.config.defaultPresetId, 'legacy-default')
  assert.equal(migrated.config.network.roomId, 'presenter-team')
  assert.equal(migrated.config.providers[0].models.length, 300)
  assert.equal(migrated.config.providers[1].enabled, false)
  assert.deepEqual(migrated.local.tasks.orchestrator, { ref: { providerId: 'http', model: 'model-042' }, reasoningEffort: 'minimal' })
  assert.equal(migrated.local.tasks.vision.reasoningEffort, 'low')
  const room = migrated.config.providers.find(p => p.baseUrl === 'mist-network://presenter-team')
  assert.deepEqual(migrated.local.roomProvide[room.id], { enabled: true, shared: [{ providerId: 'http', model: 'model-010' }] })
  assert.equal(await evaluate('document.querySelectorAll(".settings-tab-bar [role=tab]").length'), 3)
  await shot('connections')
  await evaluate('document.querySelectorAll(".settings-tab-bar [role=tab]")[1].click()')
  await until('!!document.querySelector(".provider-tasks")')
  await evaluate('document.querySelector("button[data-picker-name=orchestrator]").click()')
  await until('!!document.querySelector(".model-picker-two-pane")')
  await shot('tasks-picker')
  await evaluate('(()=>{const e=document.querySelector(".model-picker-two-pane input"); e.value="Presenter 299";e.dispatchEvent(new Event("input",{bubbles:true}));})()')
  await delay(200)
  assert.equal(await evaluate('document.querySelectorAll(".model-picker-two-pane .model-picker-option").length'), 1)
  await evaluate('(()=>{const e=Array.from(document.querySelectorAll(".model-picker-two-pane [role=option]")).find(e=>e.textContent.includes("model-299"));if(!e)throw Error("missing search result");e.click();})()')
  await delay(200)
  assert.deepEqual(await evaluate('JSON.parse(localStorage.getItem("tc-presenter:ai-settings-v2")).tasks.orchestrator.ref'), { providerId: 'http', model: 'model-299' })
  const answer = await evaluate('(async()=>{const m=await import("/src/lib/llm.ts");return m.requestChatCompletion([{role:"user",content:"test chosen ref"}],{task:"orchestrator"});})()')
  assert.equal(answer, 'Stub OK')
  await evaluate('(async()=>{const m=await import("/src/lib/llm.ts");await m.requestChatCompletion([{role:"user",content:"disabled fallback"}],{task:"worker"});await m.requestChatCompletion([{role:"user",content:[{type:"text",text:"vision"},{type:"image_url",image_url:{url:"data:image/png;base64,AA=="}}]}],{task:"vision"});})()')
  await evaluate('(async()=>{const m=await import("/src/lib/tts.ts");const c=await import("/src/lib/llmConfig.ts");const t=c.resolveVoice(c.loadLlmConfig(),"tts");await m.synthesizeSpeech({connection:t,model:t.model,voice:t.voice,text:"narration",speed:t.speed});})()')
  const calls = await evaluate('window.__calls')
  const chat = calls.filter(c => c.url.endsWith('/chat/completions'))
  assert.equal(chat[0].body.model, 'model-299'); assert.equal(chat[0].body.reasoning_effort, 'minimal')
  assert.equal(chat[1].body.model, 'model-010'); assert.equal(chat[2].body.reasoning_effort, 'low')
  assert.ok(Array.isArray(chat[2].body.messages[0].content))
  assert.ok(chat.every(c => !('temperature' in c.body)))
  assert.ok(!calls.some(c => c.url.includes('disabled.example.test')))
  assert.equal(calls.find(c => c.url.endsWith('/audio/speech')).body.speed, 1.1)
  assert.equal(await evaluate('(async()=>{const m=await import("/src/lib/llm.ts");await m.requestChatCompletion([{role:"user",content:"explicit shared default"}],{task:"orchestrator",modelRef:null});return window.__calls.filter(c=>c.url.endsWith("/chat/completions")).at(-1).body.model})()'), 'model-010')
  assert.deepEqual(await evaluate('(async()=>{const m=await import("/src/features/present/ttsTarget.ts");return m.resolveNarrationTarget({v:1,providers:[],presets:[],defaultPresetId:"",network:{roomId:""},updatedAt:"",tts:{model:"",speed:1.2}},undefined,"ja")})()'), { kind: 'browser', lang: 'ja', rate: 1.2 })
  await evaluate('document.querySelectorAll(".settings-tab-bar [role=tab]")[2].click()')
  await until('!!document.querySelector(".sharing-panel")'); await shot('sharing')
  const roomRouting = await evaluate('(async()=>{const c=await import("/src/lib/llmConfig.ts");const a=await import("/src/lib/aiSettings.ts");const n=await import("/src/lib/aiNetwork.ts");const m=await import("/src/lib/llm.ts");const t=await import("/src/lib/tts.ts");const cfg=c.loadLlmConfig();const second=c.createRoomProvider(cfg,{roomId:"presenter-second",label:"Second room"}).id;c.saveLlmConfig(cfg);const local=a.loadAiSettings();local.roomProvide[second]={enabled:true,shared:[{providerId:"http",model:"model-042"}]};a.saveAiSettings(local);const first=cfg.providers.find(p=>p.baseUrl==="mist-network://presenter-team").id;const seen=[];const chat=n.rooms.requestRoomOpenAi,tts=n.rooms.requestRoomTts;try{n.rooms.requestRoomOpenAi=async(room,request)=>{seen.push({room,body:JSON.parse(request.body)});return {status:200,contentType:"application/json",body:JSON.stringify({choices:[{message:{content:"Room OK"}}]})}};n.rooms.requestRoomTts=async(room,params)=>{seen.push({room,params});return new Blob(["audio"])};await m.requestChatCompletion([{role:"user",content:"room task"}],{task:"orchestrator",modelRef:{providerId:second,model:"raw-room-model"}});await m.requestChatCompletion([{role:"user",content:[{type:"image_url",image_url:{url:"data:image/png;base64,AA=="}}]}],{task:"vision",modelRef:{providerId:first,model:"raw-vision"}});await t.synthesizeSpeech({connection:{baseUrl:"mist-network://presenter-second",apiKey:""},model:"network-auto",voice:"",text:"room speech"});return {seen,distinct:n.rooms.roomConsumer("presenter-team")!==n.rooms.roomConsumer("presenter-second")}}finally{n.rooms.requestRoomOpenAi=chat;n.rooms.requestRoomTts=tts}})()')
  assert.equal(roomRouting.distinct, true)
  assert.equal(roomRouting.seen[0].room, 'presenter-second')
  assert.equal(roomRouting.seen[0].body.model, 'raw-room-model')
  assert.equal(roomRouting.seen[0].body.reasoning_effort, 'minimal')
  assert.equal(roomRouting.seen[1].room, 'presenter-team')
  assert.equal(roomRouting.seen[1].body.reasoning_effort, 'low')
  assert.equal(roomRouting.seen[2].params.model, undefined)
  await until('document.querySelectorAll(".sharing-room-chip").length >= 2')
  await shot('sharing-multi-room')
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false })
  await evaluate('document.querySelectorAll(".settings-tab-bar [role=tab]")[0].click()'); await shot('390px')
  assert.equal(await evaluate('document.documentElement.scrollWidth <= 390'), true)
  for (const width of [360, 390]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: false })
    assert.equal(await evaluate('document.documentElement.scrollWidth <= ' + width), true)
  }
  await evaluate('(async()=>{const a=await import("/src/lib/aiSettings.ts");const c=await import("/src/lib/llmConfig.ts");const second=c.loadLlmConfig().providers.find(p=>p.baseUrl==="mist-network://presenter-second").id;const local=a.loadAiSettings();local.roomProvide[second].enabled=false;a.saveAiSettings(local);document.querySelectorAll(".tab-bar button")[0].click()})()')
  await until('(async()=>{const n=await import("/src/lib/aiNetwork.ts");return n.rooms.roomConsumer("presenter-second").status.phase==="idle"})()')
  assert.equal(await evaluate('(async()=>{const n=await import("/src/lib/aiNetwork.ts");return n.rooms.roomConsumer("presenter-team").status.phase!=="idle"})()'), true)
  await evaluate('document.querySelectorAll(".tab-bar button")[3].click()')
  await until('!!document.querySelector(".set-locale-row select")')
  const locales = {}
  for (const locale of ['en', 'ja', 'zh-CN', 'zh-TW']) {
    await evaluate('(()=>{const s=document.querySelector(".set-locale-row select");s.value=' + JSON.stringify(locale) + ';s.dispatchEvent(new Event("change",{bubbles:true}));})()')
    await delay(100)
    locales[locale] = await evaluate('Array.from(document.querySelectorAll(".settings-tab-bar button")).map(e=>e.textContent)')
  }
  assert.deepEqual(locales.ja, ['\u63a5\u7d9a\u5148', '\u30bf\u30b9\u30af', '\u63d0\u4f9b'])
  assert.deepEqual(locales.en, ['Connections', 'Tasks', 'Sharing'])
  assert.deepEqual(locales['zh-CN'], ['\u8fde\u63a5', '\u4efb\u52a1', '\u5171\u4eab'])
  assert.deepEqual(locales['zh-TW'], ['\u9023\u7dda', '\u4efb\u52d9', '\u5206\u4eab'])
  await evaluate('document.querySelector(".theme-toggle").click();document.querySelectorAll(".settings-tab-bar [role=tab]")[1].click()')
  await until('!!document.querySelector("button[data-picker-name=orchestrator]")')
  await evaluate('document.querySelector("button[data-picker-name=orchestrator]").click()')
  await until('!!document.querySelector(".model-picker-two-pane")')
  assert.equal(await evaluate('document.documentElement.scrollWidth <= 390'), true)
  await shot('390px-dark-picker')
  await evaluate('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));document.querySelectorAll(".tab-bar button")[1].click()')
  await until('!!document.querySelector(".edt-tab")')
  await evaluate('document.querySelector(".edt-panel__actions .edt-btn--primary").click()')
  await until('!!document.querySelector("button[data-task-override=orchestrator]")')
  const savedTask = await evaluate('JSON.parse(localStorage.getItem("tc-presenter:ai-settings-v2")).tasks.orchestrator.ref')
  await evaluate('document.querySelector("button[data-task-override=orchestrator]").click()')
  await until('!!document.querySelector(".mistai-settings[role=dialog]")')
  assert.deepEqual(await evaluate('Array.from(document.querySelectorAll(".mistai-settings .settings-tab-bar button")).map(e=>e.textContent)'), locales['zh-TW'])
  await evaluate('document.querySelector(".mistai-settings button[data-picker-name=orchestrator]").click()')
  await until('!!document.querySelector(".model-picker-two-pane")')
  assert.equal(await evaluate('document.querySelector(".model-picker-two-pane input").placeholder'), '\u641c\u5c0b\u6a21\u578b\u8207\u9023\u7dda')
  await evaluate('(()=>{const e=document.querySelector(".model-picker-two-pane input");e.value="Presenter 298";e.dispatchEvent(new Event("input",{bubbles:true}))})()')
  await delay(100)
  await evaluate('document.querySelector(".model-picker-results [data-model=model-298]").click()')
  await until('!document.querySelector(".mistai-settings[role=dialog]")')
  assert.equal(await evaluate('document.querySelector("button[data-task-override=orchestrator]").textContent.includes("model-298")'), true)
  assert.deepEqual(await evaluate('JSON.parse(localStorage.getItem("tc-presenter:ai-settings-v2")).tasks.orchestrator.ref'), savedTask)
  const before = await evaluate('localStorage.getItem("tc-presenter:ai-settings-v2")')
  await send('Page.reload'); await until('!!document.querySelector(".app-shell")')
  assert.equal(await evaluate('localStorage.getItem("tc-presenter:ai-settings-v2")'), before)
  assert.deepEqual(errors, [])
  await fs.writeFile(W + '/p2-presenter-results.json', JSON.stringify({ migrated, calls, roomRouting, locales, runtimeErrors: errors, consoleErrors, idempotent: true }, null, 2))
  console.log('Presenter browser checks passed; screenshots and results saved to ' + W)
} finally { ws.close() }

import { MistaiError, streamChatCompletion, type ChatMessage } from '@tik-choco/mistai'
import { emptyLlmConfig, loadLlmConfig, resolveModel, isNetworkProviderBaseUrl, roomIdFromBaseUrl, type ModelRefV1, type ResolvedLlmTargetV1 } from './llmConfig'
import { localizeNetworkError, rooms } from './aiNetwork'
import { taskSettings, type TaskId } from './aiSettings'
import { t } from '../i18n'
export type { ChatMessage }
export type ChatContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
export type MultimodalChatMessage = { role: 'system' | 'user' | 'assistant'; content: string | ChatContentPart[] }
export const DEFAULT_LLM_TIMEOUT_MS = 120_000
export interface RequestChatOptions {
  /** Undefined uses the saved task ref; null explicitly follows the shared default. */
  modelRef?: ModelRefV1 | null
  task?: TaskId
  onDelta?: (delta: string, full: string) => void
  timeoutMs?: number
  signal?: AbortSignal
}
function withDefaultTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}
export async function requestChatCompletion(messages: MultimodalChatMessage[], options: RequestChatOptions = {}): Promise<string> {
  const cfg = loadLlmConfig() ?? emptyLlmConfig()
  const task = taskSettings(options.task ?? 'default')
  const target = resolveModel(cfg, options.modelRef === null ? undefined : options.modelRef ?? task.ref)
  if (!target) throw new Error(t('errors.llmNotConfigured'))
  const signal = withDefaultTimeout(options.signal, options.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS)
  signal.throwIfAborted()
  try {
    let content: string
    if (isNetworkProviderBaseUrl(target.baseUrl)) {
      const roomId = roomIdFromBaseUrl(target.baseUrl)
      const hasImages = messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url'))
      // Only image content needs the tunnel; text chat streams over llm_request.
      const pending = hasImages
        ? rooms.requestRoomOpenAi(roomId, {
          path: '/chat/completions', method: 'POST', contentType: 'application/json',
          body: JSON.stringify({ model: target.model, messages, stream: false, reasoning_effort: task.reasoningEffort }),
        }).then(response => {
          if (response.status < 200 || response.status >= 300) throw new MistaiError('UPSTREAM_HTTP_ERROR', response.body)
          return JSON.parse(response.body).choices?.[0]?.message?.content ?? ''
        })
        : rooms.requestRoomChat(roomId, messages.map(message => ({
          ...message,
          content: typeof message.content === 'string' ? message.content : message.content.map(part => part.type === 'text' ? part.text : '').join(''),
        })), { model: target.model, reasoningEffort: task.reasoningEffort, onDelta: options.onDelta })
      content = await new Promise<string>((resolve, reject) => {
        const abort = () => reject(signal.reason)
        signal.addEventListener('abort', abort, { once: true })
        pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
      })
      if (hasImages) options.onDelta?.(content, content)
    } else {
      let full = ''
      content = await streamChatCompletion({ ...target, reasoningEffort: task.reasoningEffort }, messages as ChatMessage[],
        options.onDelta ? delta => { full += delta; options.onDelta?.(delta, full) } : undefined,
        (input, init) => fetch(input, { ...init, signal }))
    }
    if (!content.trim()) throw new MistaiError('UPSTREAM_BAD_RESPONSE', 'Empty response')
    return content
  } catch (err) { throw new Error(localizeNetworkError(err, t('errors.llmNotConfigured'))) }
}
// Onboarding tests its unsaved HTTP draft without resolving a stored task.
export async function requestApiChatCompletionStreaming(target: ResolvedLlmTargetV1, messages: ChatMessage[], model: string | undefined, onDelta: (delta: string) => void): Promise<string> {
  const signal = withDefaultTimeout(undefined, DEFAULT_LLM_TIMEOUT_MS)
  return streamChatCompletion({ ...target, model: model ?? target.model, reasoningEffort: taskSettings('default').reasoningEffort }, messages, onDelta, (input, init) => fetch(input, { ...init, signal }))
}

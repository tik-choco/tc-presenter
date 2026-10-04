import { createRoomConsumers, createSharedNodeScope, formatMistaiError, MESSAGES_EN, MESSAGES_JA } from '@tik-choco/mistai'
import { SharedMistNode } from './mistNode'
import { getLocale } from '../i18n'
export const rooms = createRoomConsumers(createSharedNodeScope(() => new SharedMistNode()), {
  nodeIdStorageKey: 'tc-presenter-mistllm-node-id-v1',
  requestTimeoutMs: 120_000, providerWaitTimeoutMs: 30_000,
})
export function localizeNetworkError(err: unknown, fallback: string): string {
  return formatMistaiError(err, getLocale() === 'ja' ? MESSAGES_JA : MESSAGES_EN, fallback)
}

import { getLocale } from './index'

export const AI_MESSAGES = {
  en: { title: 'Settings', visionHint: 'Use vision judge during refine (configure Vision in Settings)', default: 'Default', vision: 'Vision', orchestrator: 'Deck planning', worker: 'Slide generation', model: 'Model', concurrency: 'Parallel workers', speed: 'Speech speed', onboarding: 'Show introduction', language: 'Interface language' },
  ja: { title: '設定', visionHint: '改善時に視覚評価を使う（設定で Vision を指定）', default: '既定', vision: 'Vision', orchestrator: 'デッキ構成', worker: 'スライド生成', model: 'モデル', concurrency: '並列数', speed: '読み上げ速度', onboarding: '使い方を見る', language: '表示言語' },
  'zh-CN': { title: '设置', visionHint: '优化时使用视觉评估（请在设置中配置视觉模型）', default: '默认', vision: '视觉', orchestrator: '演示文稿规划', worker: '幻灯片生成', model: '模型', concurrency: '并行任务数', speed: '朗读速度', onboarding: '查看使用介绍', language: '界面语言' },
  'zh-TW': { title: '設定', visionHint: '最佳化時使用視覺評估（請在設定中配置視覺模型）', default: '預設', vision: '視覺', orchestrator: '簡報規劃', worker: '投影片生成', model: '模型', concurrency: '並行工作數', speed: '朗讀速度', onboarding: '查看使用介紹', language: '介面語言' },
}
export function aiText(key: keyof typeof AI_MESSAGES.en): string { return AI_MESSAGES[getLocale()][key] }

import fs from 'node:fs'
import assert from 'node:assert/strict'
import ts from 'typescript'
import { LLM_SETTINGS_MESSAGES } from '@tik-choco/mistai/preact'

const source = fs.readFileSync(new URL('../src/i18n/ai.ts', import.meta.url), 'utf8').replace(/^import .*$/gm, '')
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText
const { AI_MESSAGES } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))
for (const [name, catalogs] of Object.entries({ app: AI_MESSAGES, mistai: LLM_SETTINGS_MESSAGES })) {
  const keys = Object.keys(catalogs.en).sort()
  const placeholders = text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort()
  for (const locale of ['en', 'ja', 'zh-CN', 'zh-TW']) {
    assert.deepEqual(Object.keys(catalogs[locale]).sort(), keys, name + ': ' + locale)
    for (const key of keys) {
      assert.equal(typeof catalogs[locale][key], 'string')
      assert.ok(catalogs[locale][key].trim(), name + ': ' + locale + '/' + key)
      assert.deepEqual(placeholders(catalogs[locale][key]), placeholders(catalogs.en[key]))
    }
  }
  console.log(name + ': complete in en/ja/zh-CN/zh-TW (' + keys.length + ' keys)')
}

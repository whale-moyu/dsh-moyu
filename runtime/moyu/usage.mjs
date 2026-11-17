// usage.mjs — 从 DSH 会话的累计用量算「这次摸鱼花了多少钱」
//
// 为什么要它：以前 budgetUsed 靠我自觉调 moyu.cmd spend，不调就永远是 0，
// 等于没有预算。这里读的是 DSH 自己统计的 tokenUsage（projections.values.tokenUsage），
// 用 surfcore 的官方价目表折算成人民币。
//
// 用法：
//   node usage.mjs snapshot           # 打印当前累计用量 JSON
//   node usage.mjs cost '<baseJson>'   # 打印相对 base 的花费 JSON
//
// 注意：DSH 重启后会话 id 变了、累计用量归零 —— 此时 delta 会是负数，一律夹到 0。

import { discoverDshBaseUrl } from 'file:///D:/surfcore/src/dsh-port.js'
import { NodeApiClient } from 'file:///D:/surfcore/src/dsh-client.js'
import { priceUsage } from 'file:///D:/surfcore/src/model-prices.js'
import { readFileSync } from 'node:fs'

const HINT = 'default-workspace'
const MODEL = 'deepseek-flash'

async function snapshot() {
  const base = await discoverDshBaseUrl()
  const api = new NodeApiClient(base, undefined, { token: null, tokenExplicit: false, allowRemote: false })
  await api.ensureAuth()
  const res = await api.callUnary('session/list', {})
  const items = res?.result?.value?.items ?? res?.value?.items ?? []
  const hit = items.find((x) => String(x.cwd ?? '').toLowerCase().includes(HINT)) ?? items[0]
  if (!hit) throw new Error('no session')
  // DSH 一旦改版，这里会变 undefined。以前会静默当 0（预算永不触发），现在直接报错。
  if (!hit.projections || !hit.projections.values || !hit.projections.values.tokenUsage) {
    throw new Error('tokenUsage-missing（DSH 内部结构可能变了）')
  }
  const u = hit.projections.values.tokenUsage
  const out = {
    sessionId: hit.sessionId ?? null,
    uncachedInputTokens: u.uncachedInputTokens ?? 0,
    outputTokens: u.outputTokens ?? 0,
    cacheReadTokens: u.cacheReadTokens ?? 0,
    cacheWriteTokens: u.cacheWriteTokens ?? 0
  }
  out.totalTokens = out.uncachedInputTokens + out.outputTokens + out.cacheReadTokens + out.cacheWriteTokens
  return out
}

function costOf(base, now) {
  const same = base && now && base.sessionId && now.sessionId && base.sessionId === now.sessionId
  const d = (k) => (same ? Math.max(0, (now[k] ?? 0) - (base[k] ?? 0)) : 0)
  const buckets = {
    cacheMiss: d('uncachedInputTokens'),
    cacheHit: d('cacheReadTokens'),
    cacheWrite: d('cacheWriteTokens'),
    output: d('outputTokens'),
    reasoning: 0
  }
  const { cost, rates } = priceUsage(buckets, { model: MODEL, at: Date.now() })
  return { cost, buckets, rates, sameSession: !!same }
}

const cmd = process.argv[2] || 'snapshot'
try {
  if (cmd === 'snapshot') {
    const s = await snapshot()
    process.stdout.write(JSON.stringify(s))
  } else if (cmd === 'cost') {
    // 允许两种传参：直接给 JSON，或给一个 JSON 文件路径（PowerShell 里传引号容易丢）
    const arg = process.argv[3] || '{}'
    let raw = arg
    if (!arg.trim().startsWith('{')) {
      raw = readFileSync(arg, 'utf8')
    }
    const base = JSON.parse(raw)
    const now = await snapshot()
    const r = costOf(base, now)
    process.stdout.write(JSON.stringify(r))
  } else {
    process.stderr.write('unknown command: ' + cmd + '\n')
    process.exit(2)
  }
} catch (e) {
  process.stderr.write('usage.mjs: ' + (e && e.message ? e.message : String(e)) + '\n')
  process.exit(1)
}

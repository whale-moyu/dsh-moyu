#!/usr/bin/env node
// 摸鱼报告：把这次摸鱼「碰了什么」写成一段人话，退出时生成。
// 用法：node tools/activity-report.mjs [--since ISO] [--to ISO] [--quiet]
// 读：logs/guard-seen.log、freetime/denials.log、freetime/file-writes.log、
//     ~/.dsh/tools/run.log、tools/actions.log、freetime/web-access.log、
//     freetime/web-downloads.log、freetime/sessions.log、日记文件
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const HOME = os.homedir()

function notebookRoot() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(HOME, '.dsh', 'moyu', 'config.json'), 'utf8').replace(/^\uFEFF/, ''))
    if (cfg && typeof cfg.notebook === 'string' && cfg.notebook.trim()) return cfg.notebook.trim()
  } catch {}
  return path.join(HOME, 'Desktop', '摸鱼笔记')
}
// 自检（tools/report-selftest.mjs）会把这两处指到临时目录，喂一段已知的假记录，
// 再核对报告里的数字。平时不设这两个环境变量。
const DSH = process.env.AK_DSH_HOME || path.join(HOME, '.dsh')
const MOYU = process.env.AK_MOYU_HOME || path.join(DSH, 'moyu')
const FT = path.join(MOYU, 'freetime')
const args = process.argv.slice(2)
const quiet = args.includes('--quiet')
const opt = (name, dflt) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}

function readJsonLines(file) {
  if (!fs.existsSync(file)) return []
  const out = []
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim()
    if (!t) continue
    try { out.push(JSON.parse(t)) } catch { /* 跳过坏行 */ }
  }
  return out
}

function readPlain(file) {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim())
}

function readState() {
  try { return JSON.parse(fs.readFileSync(path.join(MOYU, 'state.json'), 'utf8')) } catch { return {} }
}

const state = readState()
const nowIso = new Date().toISOString()
const since = opt('--since', state.sessionStarted || new Date(Date.now() - 3600e3).toISOString())
const to = opt('--to', nowIso)
const sinceMs = Date.parse(since)
const toMs = Date.parse(to)
const inWindow = (iso) => {
  const t = Date.parse(iso)
  return Number.isFinite(t) && t >= sinceMs - 1000 && t <= toMs + 1000
}

// 本地时间「YYYY-MM-DD HH:mm:ss」也算窗口（actions.log 用这个格式）
const localStamp = (d) => {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
const sinceLocal = localStamp(new Date(sinceMs))
const toLocal = localStamp(new Date(toMs))

// ---- 1. 工具调用 ----
const seen = []
for (const line of readPlain(path.join(MOYU, 'logs', 'guard-seen.log'))) {
  const m = line.match(/^(\S+)\s+(.+)$/)
  if (m && inWindow(m[1])) seen.push({ ts: m[1], tool: m[2].trim() })
}
const toolCount = {}
for (const s of seen) toolCount[s.tool] = (toolCount[s.tool] || 0) + 1

// ---- 2. 被拒 ----
const REASON = {
  'tool-not-allowed': '工具不在白名单',
  'boundary-write': '想写到允许的两处目录之外',
  'boundary-read': '想读凭据或会话数据',
  'boundary-exec': '想跑程序，但那一刻「跑」是关的',
  'boundary-exec-shell': '想用 shell，摸鱼里只许起地盘里的程序',
  'boundary-net': '想联网，但「联」是关的',
  'boundary-motion': '想动鼠标键盘，但「动」是关的',
  'social-off': '想发消息，社交全关',
  'social-owner-only': '想发消息给别人，只许发给主人',
  'moyu-ban': '这个工具在摸鱼里永久禁用',
  'boundary-tampered': '边界被从外面改过',
  'deny-mode': '不在摸鱼模式',
  'mcp-default-deny': 'MCP 工具默认全拒',
}
const denials = readJsonLines(path.join(FT, 'denials.log')).filter((d) => inWindow(d.ts))
const denialByReason = {}
for (const d of denials) {
  const k = d.reason || 'other'
  denialByReason[k] = denialByReason[k] || { n: 0, tools: new Set() }
  denialByReason[k].n++
  denialByReason[k].tools.add(d.tool)
}

// ---- 3. 写了哪些文件 ----
const writes = readJsonLines(path.join(FT, 'file-writes.log')).filter((w) => inWindow(w.ts))
const writePaths = [...new Set(writes.map((w) => w.path))]
const short = (p) => p.replace(HOME, '~')

// ---- 4. 起了什么程序 ----
const runs = readJsonLines(path.join(DSH, 'tools', 'run.log')).filter((r) => inWindow(r.ts))
const runByExe = {}
for (const r of runs) {
  const name = path.basename(String(r.exe || '?')).replace(/\.exe$/i, '')
  const b = (runByExe[name] = runByExe[name] || { n: 0, ok: 0, timedOut: 0 })
  b.n++
  if (r.ok) b.ok++
  if (r.timedOut) b.timedOut++
}

// ---- 5. 鼠标键盘 ----
const actions = []
for (const line of readPlain(path.join(MOYU, 'tools', 'actions.log'))) {
  const m = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s+(REFUSED|OK)?\s*(\S+)/)
  if (!m) continue
  if (m[1] < sinceLocal || m[1] > toLocal) continue
  actions.push({ ts: m[1], refused: m[2] === 'REFUSED', what: m[3] })
}
const actOk = actions.filter((a) => !a.refused).length
const actBad = actions.filter((a) => a.refused).length

// ---- 6. 上网 ----
const hosts = {}
for (const line of readPlain(path.join(FT, 'web-access.log'))) {
  const m = line.match(/^(\S+)\s+(ALLOW|DENY)\s+(\S+?):\d+/)
  if (!m || !inWindow(m[1])) continue
  if (m[2] === 'DENY') continue
  const h = m[3]
  hosts[h] = (hosts[h] || 0) + 1
}
const hostList = Object.entries(hosts).sort((a, b) => b[1] - a[1])
const downloads = readJsonLines(path.join(FT, 'web-downloads.log')).filter((d) => inWindow(d.ts))

// ---- 7. 这次的会话记录 ----
const sessions = readJsonLines(path.join(FT, 'sessions.log'))
// 按窗口挑这一趟对应的会话；挑不到就不显示那行（以前写死最后一条，给某个时间段
// 生成报告时会拿到别的趟的数——2026-11-17 实测出现「16 分钟」配「2 分钟」）。
const lastSession = (() => {
  const inWin = sessions.filter((x) => {
    const t = Date.parse(x.startedAt || '')
    return Number.isFinite(t) && t >= sinceMs - 60e3 && t <= toMs + 60e3
  })
  if (inWin.length) return inWin[inWin.length - 1]
  // 报告是退出时生成的，会话记录可能是几秒后才落盘：退一步接受「结束时间在窗口内」的那条。
  const byEnd = sessions.filter((x) => {
    const t = Date.parse(x.endedAt || '')
    return Number.isFinite(t) && t >= sinceMs - 60e3 && t <= toMs + 60e3
  })
  return byEnd.length ? byEnd[byEnd.length - 1] : {}
})()

// ---- 8. 日记当天行数 ----
const d = new Date(sinceMs)
const pad = (n) => String(n).padStart(2, '0')
const dayName = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.md`
const diaryPath = path.join(FT, 'diary', dayName)
const diaryLines = fs.existsSync(diaryPath) ? readPlain(diaryPath).length : 0

// ---- 生成 ----
const startLocal = localStamp(new Date(sinceMs))
const endLocal = localStamp(new Date(toMs))
const durMin = Math.max(0, Math.round((toMs - sinceMs) / 60000))
const sessionsLine = seen.length
  ? `这次摸鱼 ${startLocal.slice(11, 16)} 到 ${endLocal.slice(11, 16)}，${durMin} 分钟。`
  : `这次摸鱼 ${startLocal.slice(11, 16)} 到 ${endLocal.slice(11, 16)}，${durMin} 分钟，一条工具调用都没记到。`

const oneLine = [
  `工具调用 ${seen.length} 次`,
  denials.length ? `被拒 ${denials.length} 次` : '没被拒过',
  runs.length ? `起了 ${runs.length} 次程序` : '没起过程序',
  hostList.length ? `上了 ${hostList.length} 个网站` : '没上网',
  actOk || actBad ? `碰鼠标键盘 ${actOk + actBad} 次` : '没碰鼠标键盘',
].join('，')

// 退出原因说人话（用户 2026-11-17：「不要那种英文的」）
const REASON_CN = {
  manual: '主人手动退出',
  'window-ended': '到点了',
  budget: '额度超了',
  timeout: '到点了',
  idle: '自己收的',
  crash: '异常退出',
  self: '自己退出的',
}

const L = []
L.push(`# 摸鱼报告 · ${startLocal}`)
L.push('')
L.push(sessionsLine + (lastSession.reason
  ? `退出方式：${REASON_CN[lastSession.reason] || lastSession.reason}。`
  : ''))
L.push('')
L.push('## 一句话')
L.push('')
L.push(oneLine + '。')
L.push('')

L.push('## 动了哪些文件')
L.push('')
if (writePaths.length) {
  L.push(`写了 ${writePaths.length} 个：`)
  L.push('')
  for (const p of writePaths.slice(0, 15)) L.push(`- \`${short(p)}\``)
  if (writePaths.length > 15) L.push(`- ……另外 ${writePaths.length - 15} 个`)
} else {
  L.push('一个文件都没写。')
}
L.push('')

L.push('## 起了什么程序')
L.push('')
if (runs.length) {
  for (const [name, b] of Object.entries(runByExe)) {
    const bits = [`${b.n} 次`, `${b.ok} 次正常结束`]
    if (b.timedOut) bits.push(`${b.timedOut} 次跑到超时被杀`)
    L.push(`- \`${name}\`：${bits.join('，')}`)
  }
} else {
  L.push('一个程序都没起。')
}
L.push('')

L.push('## 想做但被拦下的')
L.push('')
if (denials.length) {
  const rows = Object.entries(denialByReason).sort((a, b) => b[1].n - a[1].n)
  for (const [reason, v] of rows) {
    L.push(`- ${REASON[reason] || reason}：${v.n} 次（${[...v.tools].join('、')}）`)
  }
} else {
  L.push('没有。这趟没撞过边界。')
}
L.push('')

L.push('## 上网')
L.push('')
if (hostList.length) {
  L.push(`放行了 ${hostList.length} 个域名，前几个：`)
  L.push('')
  for (const [h, n] of hostList.slice(0, 10)) L.push(`- ${h}（${n} 次）`)
} else {
  L.push('没上网。')
}
if (downloads.length) {
  L.push('')
  L.push(`下载 ${downloads.length} 个文件：`)
  for (const x of downloads.slice(0, 5)) L.push(`- ${x.name || x.file || '?'}`)
}
L.push('')

L.push('## 碰鼠标键盘')
L.push('')
if (actOk || actBad) {
  L.push(`放行 ${actOk} 次，被拒 ${actBad} 次。`)
} else {
  L.push('一次都没动。')
}
L.push('')

L.push('## 这趟留下了什么')
L.push('')
L.push(`- 摸鱼日记 \`${diaryPath.replace(HOME, '~')}\`：${diaryLines} 行`)
L.push(`- 会话记录：${lastSession.durMin != null ? `${lastSession.durMin} 分钟、${lastSession.actions ?? 0} 个动作、${lastSession.wakes ?? 0} 次自我唤醒` : '（这条还没写进来）'}`)
L.push('')

const txt = L.join('\n')

// ---- 落盘 ----
const reportDir = path.join(FT, 'reports')
fs.mkdirSync(reportDir, { recursive: true })
const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
const outFile = path.join(reportDir, `摸鱼报告-${stamp}.md`)
fs.writeFileSync(outFile, txt + '\n', 'utf8')

// 副本给主人看：日记本里专门一格
let copyTo = null
try {
  if (process.env.AK_MOYU_HOME) throw new Error('自检模式：不写日记本')
  const nb = path.join(notebookRoot(), '自建插件', '摸鱼模式', '报告')
  fs.mkdirSync(nb, { recursive: true })
  copyTo = path.join(nb, `摸鱼报告-${stamp}.md`)
  fs.writeFileSync(copyTo, txt + '\n', 'utf8')
} catch { /* 日记本不在就算了 */ }

if (!quiet) {
  console.log(outFile)
  if (copyTo) console.log(copyTo)
}

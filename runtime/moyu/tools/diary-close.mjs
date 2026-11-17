// diary-close.mjs —— 退出摸鱼时，在「今天的摸鱼日记」里补一段事实占位。
//
// 为什么要单开一个：这段逻辑原来只在 moyu.ps1 的 exit 分支里（PowerShell），
// 而 moyu_exit 工具走的是插件里的 doExitMoyu()，两条路互不相干 ——
// 结果用工具退出的那些趟，日记里什么都没留下（2026-11-13 之后就没再出现过新日记）。
//
// 用法：node diary-close.mjs [--stamp HH:mm]
// 行为：freetime/diary/<yyyy-mm-dd>.md 里没有「## HH:mm」这一节，就补一段；
//       已经有就什么都不做。只写事实（时间/花费/续几次），改写成真话是醒来后的事。

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const HOME = process.env.USERPROFILE || os.homedir()

function notebookRoot() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(HOME, '.dsh', 'moyu', 'config.json'), 'utf8').replace(/^\uFEFF/, ''))
    if (cfg && typeof cfg.notebook === 'string' && cfg.notebook.trim()) return cfg.notebook.trim()
  } catch {}
  return path.join(HOME, 'Desktop', '摸鱼笔记')
}
const MOYU = process.env.DSH_MOYU_DIR || path.join(HOME, '.dsh', 'moyu')
const STATE = path.join(MOYU, 'state.json')
const DIR = path.join(MOYU, 'freetime', 'diary')

function readJson (p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
}
function hm (iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '?'
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}
function localDate (d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

const st = readJson(STATE)
if (!st || !st.sessionStarted) {
  console.log('skip: no sessionStarted in state.json')
  process.exit(0)
}

const start = hm(st.sessionStarted)
const end = st.sessionEnded ? hm(st.sessionEnded) : hm(new Date().toISOString())
const used = Number(st.budgetUsed) || 0
const cap = Number(st.budgetYuan) || 0
const wakes = Number(st.wakeCount) || 0
const money = cap > 0 ? `${used} / ${cap} 元` : `${used} 元`

fs.mkdirSync(DIR, { recursive: true })
const file = path.join(DIR, localDate(new Date()) + '.md')
const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''

// 已经有这一段就不重复写（以「## HH:mm」开头判断）
const marker = new RegExp('^##\\s*' + start.replace(':', '\\:'), 'm')
if (marker.test(existing)) {
  console.log('skip: section ' + start + ' already in ' + path.basename(file))
  process.exit(0)
}

const block = `\r\n## ${start} 自动记录（待改写）\r\n\r\n窗口 ${start} → ${end} · 用 ${money} · 续 ${wakes} 次\r\n\r\n（这段是程序在退出时自动落的，只有事实，没有话。下次醒来时把它改成真话。）\r\n`
fs.appendFileSync(file, block, 'utf8')
console.log('wrote ' + path.basename(file) + ' section ' + start)

// 顺手抄一份到日记本：用户不知道摸鱼日记在哪，翻 ~/.dsh 太费劲（2026-11-17）。
try {
  const box = path.join(notebookRoot(), '自建插件', '摸鱼模式', '摸鱼日记')
  fs.mkdirSync(box, { recursive: true })
  fs.copyFileSync(file, path.join(box, path.basename(file)))
  console.log('copied to ' + box)
} catch (e) { console.log('copy skipped: ' + e.message) }

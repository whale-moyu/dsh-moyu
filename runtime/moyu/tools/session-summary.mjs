// session-summary.mjs —— 每次退出摸鱼时收一次尾（2026-11-16 用户批「按 123 改」里的第 1 条）
//
// 为什么要有：日志是给排查用的流水，不是给人看的记录。摸完一趟什么都留不下，等于白进去。
// 这里只做一件事：在本轮已经结束、但 state 还没被改掉之前，把这一趟写成三行给人看的东西。
//
// 用法：node session-summary.mjs --reason window-ended|budget|manual|play-record
// 产物：freetime/sessions.log（一行 JSON，给机器）+ freetime/摸鱼流水.md（三行，给人）

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const ROOT = (process.env.USERPROFILE || 'C:/Users').replace(/\\/g, '/') + '/.dsh/moyu'
const STATE = path.join(ROOT, 'state.json')
const PLAY = path.join(ROOT, 'tools', 'play-state.json')
const GUARD_LOG = path.join(ROOT, 'logs', 'guard.log')
const BOUNDARY = path.join(ROOT, 'logs', 'boundary.log')
const ACTIONS = path.join(DIR, 'actions.log')
const DIR = path.join(ROOT, 'freetime')
const JSON_LOG = path.join(DIR, 'sessions.log')
const MD = path.join(DIR, '摸鱼流水.md')

const REASON = (() => {
  const i = process.argv.indexOf('--reason')
  return i >= 0 ? String(process.argv[i + 1] || 'unknown') : 'unknown'
})()

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
}

function readLines(p) {
  try { return fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean) } catch { return [] }
}

function hm(iso) {
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return '?'
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
  } catch { return '?' }
}

function main() {
  // 先把日记里的「想要/做完/值」抽走：这是下一次醒来能读到的东西，
  // 晚一步写 state 就查不到今天的日记归属了（虽然按日期找也能找到，但顺序更稳）。
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'tools', 'prefs.mjs'), '--harvest'], { encoding: 'utf8', timeout: 20000, windowsHide: true })
  } catch (e) { console.error('harvest failed: ' + e.message) }

  const st = readJson(STATE) || {}
  const startedAt = st.sessionStarted || null
  const endedAt = (() => {
  // 和 startedAt 保持同一种写法（本地时间带 +08:00），否则报告按窗口筛的时候会对不上。
  const d = new Date(Date.now() + 8 * 3600e3)
  return d.toISOString().replace('Z', '+08:00')
})()
  const startMs = startedAt ? Date.parse(startedAt) : NaN
  // 脏数据保护：state.json 有时会留着上一轮的 sessionStarted（异常退出没清），
  // 算出来能是几千分钟。超过 12 小时就当没记到，别让流水里出现「走了三天」。
  let durMin = Number.isFinite(startMs) ? Math.max(1, Math.round((Date.now() - startMs) / 60000)) : null
  if (durMin != null && durMin > 720) durMin = null

  // 这一趟里我动过多少次桌面。
  // boundary.log 是 desktop.ps1 的流水，但这台机器上它一直没生成（2026-11-17 查到的），
  // 所以先读它，读不到就退回 tools/actions.log（moyu_desktop 每次动作都会写）。
  let actions = 0
  let src = 'boundary'
  for (const line of readLines(BOUNDARY)) {
    if (!line.includes('result=ok')) continue
    const t = Date.parse(line.slice(0, 19).replace(' ', 'T'))
    if (Number.isFinite(t) && Number.isFinite(startMs) && t >= startMs) actions++
  }
  if (actions === 0) {
    src = 'actions'
    for (const line of readLines(ACTIONS)) {
      // 格式是「2026-11-17 13:35:30 shot {...}」，没方括号
      const m = line.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/)
      if (!m) continue
      const t = Date.parse(m[1].replace(/-/g, '/') + ' ' + m[2])
      if (Number.isFinite(t) && Number.isFinite(startMs) && t >= startMs) actions++
    }
  }

  // 这一段 guard 说了什么（只取时间戳在窗口内的）
  const guardLines = readLines(GUARD_LOG).filter((l) => {
    const t = Date.parse(l.slice(0, 24))
    return Number.isFinite(t) && Number.isFinite(startMs) && t >= startMs
  })
  const wakes = guardLines.filter((l) => /wake|nudge|poke/i.test(l)).length
  const incidents = guardLines.filter((l) => /recover|lost DSH|incident/i.test(l)).length

  const ps = readJson(PLAY) || {}
  const sameSession = ps && ps.sessionStarted && ps.sessionStarted === startedAt
  const playMin = sameSession ? Math.floor((Number(ps.playMs) || 0) / 60000) : 0

  const used = Number(st.budgetUsed) || 0
  const cap = Number(st.budgetYuan) || 0
  const money = cap > 0 ? `${used.toFixed(2)} / ${cap.toFixed(2)} 元` : `${used.toFixed(2)} 元`

  const rec = {
    startedAt, endedAt, durMin, actions, wakes, incidents, playMin,
    budgetUsed: used, budgetYuan: cap, reason: REASON,
  }

  try { fs.mkdirSync(DIR, { recursive: true }) } catch {}
  try { fs.appendFileSync(JSON_LOG, JSON.stringify(rec) + '\n') } catch {}

  const head = `- ${hm(startedAt)}–${hm(endedAt)}（${durMin == null ? '?' : durMin} 分钟，${REASON}）`
  const body = [
    `  钱：${money}${playMin > 0 ? ` · 其中玩游戏 ${playMin} 分钟` : ''}`,
    `  手：桌面动作 ${actions} 次 · 被叫醒 ${wakes} 次${incidents ? ` · 恢复 ${incidents} 次` : ''}`,
  ]
  try {
    if (!fs.existsSync(MD)) fs.writeFileSync(MD, '# 摸鱼流水\n\n每趟三行：走了多久、花了多少、动了多少。\n\n', 'utf8')
    fs.appendFileSync(MD, head + '\n' + body.join('\n') + '\n\n', 'utf8')
  } catch (e) {
    console.error('write md failed: ' + e.message)
  }

  console.log(JSON.stringify(rec))
}

main()

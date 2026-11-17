// playwatch.mjs — 摸鱼期间的「在玩多久」采样器
//
// 只做三件事：看一眼、记一行、报个状态。不改 state.json（那是运行时状态，
// 别的脚本会整体重写它），记账全部落在自己的两个文件里：
//   play-state.json  当前这次窗口的累计（按 sessionStarted 归属，换窗口自动归零）
//   play-log.jsonl   每次采样一行，出问题能回看
//
// 判定「在玩」需要两个条件同时成立：
//   1) guard.json 的 allowApps 里某个程序正在跑
//   2) 最近 10 分钟里有桌面动作落进 boundary.log（说明真的在操作，不是挂着）
// 只有 1 没有 2，说明人在别处，不算玩。
//
// 输出一行 JSON，给 guard.mjs 读。任何异常都不往外抛，返回 playing:false。

import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MOYU = path.dirname(HERE)
const STATE = path.join(MOYU, 'state.json')
const CONFIG = path.join(MOYU, 'config.json')
const GUARD = path.join(HERE, 'guard.json')
const PLAY_STATE = path.join(HERE, 'play-state.json')
const PLAY_LOG = path.join(HERE, 'play-log.jsonl')

const DEFAULT_REMIND_MIN = 40
const DEFAULT_LIMIT_MIN = 60
const ACTIVE_WINDOW_MS = 10 * 60 * 1000
const SEGMENT_GAP_MS = 3 * 60 * 1000

function readJson(p) {
  try {
    if (!existsSync(p)) return null
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch (e) {
    return null
  }
}

function isoLocal(d) {
  const p = (n) => String(n).padStart(2, '0')
  const o = -d.getTimezoneOffset()
  const sign = o >= 0 ? '+' : '-'
  const ah = p(Math.floor(Math.abs(o) / 60))
  const am = p(Math.abs(o) % 60)
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${ah}:${am}`
}

function runningProcessNames() {
  try {
    const out = execFileSync('tasklist', ['/fo', 'csv', '/nh'], {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
    })
    const names = []
    for (const line of out.split(/\r?\n/)) {
      const m = /^"([^"]+)"/.exec(line.trim())
      if (m) names.push(m[1].toLowerCase())
    }
    return names
  } catch (e) {
    return []
  }
}

function boundaryLogPath() {
  const gj = readJson(GUARD)
  if (gj && gj.boundaryLog) return String(gj.boundaryLog)
  const a = path.join(HERE, 'boundary.log')
  if (existsSync(a)) return a
  return path.join(MOYU, 'logs', 'boundary.log')
}

function recentActionCount() {
  try {
    const p = boundaryLogPath()
    if (!existsSync(p)) return null // 没有日志就不拿它当判据
    const raw = readFileSync(p, 'utf8')
    const lines = raw.split(/\r?\n/)
    const cutoff = Date.now() - ACTIVE_WINDOW_MS
    let n = 0
    // 只扫最后 400 行，日志再大也不会拖时间
    for (let i = Math.max(0, lines.length - 400); i < lines.length; i++) {
      const line = lines[i]
      if (!line || line.indexOf('result=ok') < 0) continue
      const ts = line.slice(0, 19)
      const t = Date.parse(ts.replace(' ', 'T'))
      if (Number.isFinite(t) && t >= cutoff) n++
    }
    return n
  } catch (e) {
    return null
  }
}

function main() {
  const st = readJson(STATE) || {}
  const out = {
    at: isoLocal(new Date()),
    mode: st.mode || 'code',
    sessionStarted: st.sessionStarted || null,
    game: null,
    actions: null,
    playing: false,
    playMin: 0,
    remind: false,
    stop: false,
    limitMin: DEFAULT_LIMIT_MIN,
    remindMin: DEFAULT_REMIND_MIN,
  }
  if (st.mode !== 'moyu') return out

  const cfg = readJson(CONFIG) || {}
  const gj = readJson(GUARD) || {}
  const allow = Array.isArray(gj.allowApps) ? gj.allowApps.map((s) => String(s).toLowerCase()) : []
  const remindMin = Number(cfg.play && cfg.play.remindMinutes) || DEFAULT_REMIND_MIN
  const limitMin = Number(cfg.play && cfg.play.limitMinutes) || DEFAULT_LIMIT_MIN
  out.remindMin = remindMin
  out.limitMin = limitMin

  const procs = runningProcessNames()
  const hit = allow.find((a) => {
    const want = a.endsWith('.exe') ? a : a + '.exe'
    return procs.includes(want) || procs.includes(a)
  })
  out.game = hit || null

  const actions = recentActionCount()
  out.actions = actions

  let playing = false
  if (hit) {
    // 有桌面日志就要求有动作；没有日志（被删/换机器）就只按进程算，别把功能卡死
    playing = actions === null ? true : actions > 0
  }
  out.playing = playing

  const now = Date.now()
  const prev = readJson(PLAY_STATE)
  const sameSession = prev && prev.sessionStarted && prev.sessionStarted === st.sessionStarted
  let playMs = sameSession ? Number(prev.playMs) || 0 : 0
  if (playing) {
    if (sameSession && prev.playing && prev.lastAt) {
      const gap = now - Number(prev.lastAt)
      if (gap > 0 && gap <= SEGMENT_GAP_MS) playMs += gap
    }
  }
  const playMin = Math.floor(playMs / 60000)
  out.playMin = playMin
  out.remind = playMs >= remindMin * 60000
  out.stop = playMs >= limitMin * 60000

  const next = {
    sessionStarted: st.sessionStarted || null,
    playMs,
    lastAt: now,
    playing,
    game: hit || null,
    actions,
    remindedAt: sameSession ? prev.remindedAt || null : null,
    updatedAt: out.at,
  }
  if (out.remind && !next.remindedAt) next.remindedAt = out.at
  try {
    writeFileSync(PLAY_STATE, JSON.stringify(next, null, 2), 'utf8')
  } catch (e) {}
  try {
    appendFileSync(PLAY_LOG, JSON.stringify({ t: now, ts: out.at, game: hit, actions, playing, playMin }) + '\n', 'utf8')
  } catch (e) {}

  return out
}

let result
try {
  result = main()
} catch (e) {
  result = { at: isoLocal(new Date()), error: String((e && e.message) || e), playing: false, stop: false }
}
process.stdout.write(JSON.stringify(result) + '\n')

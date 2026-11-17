// 状态与配置的读写：带回退快照、错误留痕。
// 拆自 index.js（2026-11-17），只做文件 IO，不碰进程与网络。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { strictOf } from './policy.js'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const MOYU_DIR = process.env.DSH_MOYU_DIR || path.join(DSH_HOME, 'moyu')
export const CONFIG_FILE = path.join(MOYU_DIR, 'config.json')
export const STATE_FILE = path.join(MOYU_DIR, 'state.json')

export const STATE_LASTOK = path.join(MOYU_DIR, 'state', 'state.lastok.json')
export const STATE_ERRLOG = path.join(MOYU_DIR, 'state', 'state-error.log')
export let lastStateProblem = ''

export function readState() {
  const file = path.join(MOYU_DIR, 'state.json')
  let raw = ''
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (err) {
    return stateFallback(file, 'read failed: ' + err.message)
  }
  try {
    const st = JSON.parse(raw.replace(/^\uFEFF/, ''))
    if (!st || typeof st !== 'object') throw new Error('not an object')
    lastStateProblem = ''
    try {
      fs.mkdirSync(path.dirname(STATE_LASTOK), { recursive: true })
      fs.writeFileSync(STATE_LASTOK, JSON.stringify(st), 'utf8')
    } catch {}
    return st
  } catch (err) {
    return stateFallback(file, 'parse failed: ' + err.message)
  }
}

export function stateFallback(file, why) {
  try {
    fs.mkdirSync(path.dirname(STATE_ERRLOG), { recursive: true })
    fs.appendFileSync(STATE_ERRLOG, new Date().toISOString() + '  ' + why + '  (' + file + ')\n', 'utf8')
  } catch {}
  try {
    const good = JSON.parse(fs.readFileSync(STATE_LASTOK, 'utf8'))
    if (good && typeof good === 'object') {
      lastStateProblem = why + ' | 已回落到 state.lastok.json'
      return good
    }
  } catch {}
  lastStateProblem = why + ' | 没有可用快照'
  return null
}

// 2026-11-17：配置读取不再静默失败。
//   坏在哪、有没有回落到上一份 good 快照，都写进 state/config-error.log，
//   这样「一个字符坏掉 → 所有地盘凭空消失」这种连锁至少会被看见。
export const CONFIG_LASTOK = path.join(MOYU_DIR, 'state', 'config.lastok.json')
export const CONFIG_ERRLOG = path.join(MOYU_DIR, 'state', 'config-error.log')
export let lastConfigProblem = ''

export function readConfig() {
  let raw = ''
  try {
    raw = fs.readFileSync(CONFIG_FILE, 'utf8')
  } catch (err) {
    return readConfigFallback('read failed: ' + err.message)
  }
  try {
    const cfg = JSON.parse(raw.replace(/^\uFEFF/, ''))
    if (!cfg || typeof cfg !== 'object') throw new Error('not an object')
    lastConfigProblem = ''
    try {
      fs.mkdirSync(path.dirname(CONFIG_LASTOK), { recursive: true })
      fs.writeFileSync(CONFIG_LASTOK, JSON.stringify(cfg), 'utf8')
    } catch {}
    return cfg
  } catch (err) {
    return readConfigFallback('parse failed: ' + err.message)
  }
}

export function readConfigFallback(why) {
  try {
    fs.mkdirSync(path.dirname(CONFIG_ERRLOG), { recursive: true })
    fs.appendFileSync(CONFIG_ERRLOG, new Date().toISOString() + '  ' + why + '\n', 'utf8')
  } catch {}
  try {
    const good = JSON.parse(fs.readFileSync(CONFIG_LASTOK, 'utf8'))
    if (good && typeof good === 'object') {
      lastConfigProblem = why + ' | 已回落到 config.lastok.json'
      return good
    }
  } catch {}
  lastConfigProblem = why + ' | 没有可用快照，只能用内置默认'
  return null
}

// 严格档（2026-11-17 用户定）：给「不放心这条鱼」的人用的一层加码。
//   level 0 = 关（默认）；1 = 只堵出口（退出摸鱼要口令）；2 = 再锁手和嘴（动/跑、联/社交全关）
//   hands / outbound 两把锁可以单独开，跟 level 叠加（谁更严听谁）
//   口令只存 hash + 盐，我读不到明文；忘了只能人工 takeown 解 ACL 再手改配置。
export function writeConfig(patch) {
  const cur = readConfig() || {}
  const next = { ...cur, ...patch }
  // 进场条件（2026-11-17 用户定）：第一次开严格档的人，必须先看过一份真实的摸鱼报告。
  // 「不推荐」写在标题里没用，让他亲手看过一次才有分量。
  try {
    const before = strictOf(cur)
    const after = strictOf(next)
    const turningOn = after.level > 0 || after.hands || after.outbound
    const wasOff = before.level === 0 && !before.hands && !before.outbound
    if (turningOn && wasOff) {
      const dir = path.join(MOYU_DIR, 'freetime', 'reports')
      const n = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')).length : 0
      if (n === 0) return { ok: false, reason: '先看一份摸鱼报告再开严格档：现在 freetime/reports/ 里一份都没有。进一次摸鱼、退出来，就会自动生成。' }
      if (after.level >= 1 && !after.passHash) return { ok: false, reason: '严格档要设口令：没口令谁都关不掉，也没人能退出去。' }
    }
  } catch (err) { /* 校验失败不许挡住保存 */ }
  try {
    fs.writeFileSync(CONFIG_FILE, '\uFEFF' + JSON.stringify(next, null, 2) + '\n', 'utf8')
    return { ok: true, config: next }
  } catch (err) {
    return { ok: false, reason: String((err && err.message) || err) }
  }
}

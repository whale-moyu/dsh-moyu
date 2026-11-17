// 摸鱼·预约单（2026-11-16）
// 只做一件事：记下「什么时候可以进摸鱼」，以及这个授权是不是用户按过的那只手。
//
// 三条硬规矩（写在代码里，不是口号）：
//   1) 预约单只带「时间」，**不带预算/时长**。窗口参数永远从 config.json 读（moyu.ps1 本来就这么做，
//      命令行传 budget/minutes 会被忽略并记 param-ignored）。这样预约不会变成"绕过设置页"的后门。
//   2) 默认 confirm=required：到点不自动进，要先 confirm 一次；10 分钟不确认就作废。
//   3) 一次性。用过/过期即删。没有"每天自动"这种长期授权（真要周期性，让用户每次重新 grant）。

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const ROOT = (process.env.USERPROFILE || 'C:/Users').replace(/\\/g, '/') + '/.dsh/moyu'
const FILE = path.join(ROOT, 'grant.json')
const LOG = path.join(ROOT, 'logs', 'grant.log')
const CONFIRM_WINDOW_MS = 10 * 60 * 1000

function log(line) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true })
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`)
  } catch {}
}

export function readGrants() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    return Array.isArray(j.items) ? j.items : []
  } catch {
    return []
  }
}

function writeGrants(items) {
  fs.mkdirSync(ROOT, { recursive: true })
  const tmp = FILE + '.writing'
  fs.writeFileSync(tmp, JSON.stringify({ items }, null, 2), 'utf8')
  fs.renameSync(tmp, FILE)
}

// '22:30' -> 今天/明天那个时刻；'+90' -> 90 分钟后；ISO 原样
// 2026-11-16：手填的时间必须严格校验。旧版靠 new Date() 兜底，
// "12:30:99" / "-5" 会被 JS 塞成 1999、2001 这种荒唐日期，直到闸里才作废。
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?$/

export function parseAt(spec, now = new Date()) {
  const s = String(spec || '').trim()
  if (!s) throw new Error('missing time')

  let d
  if (/^\+\d{1,4}$/.test(s)) {
    const mins = Number(s.slice(1))
    if (mins < 1 || mins > 1440) throw new Error(`bad time: ${s}（+N 要 1..1440 分钟）`)
    d = new Date(now.getTime() + mins * 60000)
  } else if (/^\d{1,2}:\d{2}$/.test(s)) {
    const [h, m] = s.split(':').map(Number)
    if (h > 23 || m > 59) throw new Error(`bad time: ${s}（小时 0-23，分钟 0-59）`)
    d = new Date(now)
    d.setHours(h, m, 0, 0)
    if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1)
  } else if (ISO_RE.test(s)) {
    d = new Date(s)
    if (Number.isNaN(d.getTime())) throw new Error(`bad time: ${s}`)
  } else {
    throw new Error(`bad time: ${s}（只认 HH:MM / +分钟 / ISO）`)
  }

  if (d.getTime() <= now.getTime() - 60000) throw new Error(`时间已经过去了: ${d.toLocaleString()}`)
  if (d.getTime() > now.getTime() + 30 * 86400000) throw new Error('最远只能排 30 天内')
  return d
}

export function addGrant({ at, confirm = 'required', note = '', onlyIfIdle = false, now = new Date() }) {
  const when = parseAt(at, now)
  const items = readGrants().filter((g) => !g.usedAt)
  const g = {
    id: crypto.randomUUID().slice(0, 8),
    at: when.toISOString(),
    confirm: confirm === 'none' ? 'none' : 'required',
    // onlyIfIdle：到点时如果我还停不下来，就顺延 15 分钟（最多顺延 4 次）。
    // 这不是新权限，只是让「什么时候开」更贴现实——用户 2026-11-16 要的。
    onlyIfIdle: !!onlyIfIdle,
    deferred: 0,
    confirmAt: null,
    notifiedAt: null,
    note: String(note || ''),
    createdAt: now.toISOString(),
  }
  items.push(g)
  writeGrants(items)
  log(`add id=${g.id} at=${g.at} confirm=${g.confirm} idle=${g.onlyIfIdle} note=${g.note}`)
  return g
}

// 顺延：只在 onlyIfIdle 时由 gate 调用，写回新的 at 并记一笔。
export function deferGrant(id, minutes = 15, reason = 'busy') {
  const items = readGrants()
  const g = items.find((x) => x.id === id)
  if (!g) return null
  const n = Number(g.deferred) || 0
  if (n >= 4) { log(`defer-giveup id=${id} (4 次顺延)`); cancelGrant(id); return null }
  g.at = new Date(Date.now() + minutes * 60000).toISOString()
  g.deferred = n + 1
  g.notifiedAt = null
  g.confirmAt = null
  writeGrants(items)
  log(`defer id=${id} -> ${g.at} (${reason}, #${g.deferred})`)
  return g
}

export function confirmGrant(id, now = new Date()) {
  const items = readGrants()
  const g = items.find((x) => x.id === id)
  if (!g) return null
  g.confirmAt = now.toISOString()
  writeGrants(items)
  log(`confirm id=${g.id}`)
  return g
}

export function cancelGrant(id) {
  const items = readGrants().filter((x) => x.id !== id)
  writeGrants(items)
  log(`cancel id=${id}`)
}

export function markUsed(id, now = new Date()) {
  const items = readGrants()
  const g = items.find((x) => x.id === id)
  if (!g) return
  g.usedAt = now.toISOString()
  writeGrants(items.filter((x) => !(x.id === id)))
  log(`used id=${id}`)
}

export function markNotified(id, now = new Date()) {
  const items = readGrants()
  const g = items.find((x) => x.id === id)
  if (!g) return
  g.notifiedAt = now.toISOString()
  writeGrants(items)
}

// 返回「现在该处理的那一条」+ 结论
export function evaluate(now = new Date()) {
  const items = readGrants()
  const alive = []
  for (const g of items) {
    const dueMs = Date.parse(g.at) - now.getTime()
    const ageMs = now.getTime() - Date.parse(g.createdAt || g.at)
    if (dueMs > 0) { alive.push(g); continue }                     // 还没到点
    if (g.confirm === 'required' && !g.confirmAt) {
      if (ageMs > CONFIRM_WINDOW_MS) { log(`expire id=${g.id} (unconfirmed)`); continue }
      alive.push(g)
      return { grant: g, action: 'notify', reason: 'awaiting-confirm' }
    }
    alive.push(g)
    return { grant: g, action: 'enter', reason: 'due' }
  }
  if (alive.length !== items.length) writeGrants(alive)
  return { grant: null, action: 'idle', reason: '' }
}

// ── CLI ─────────────────────────────────────────────────────────────
const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('/grant.mjs')
if (isMain) {
  const [cmd, a, b] = process.argv.slice(2)
  const now = new Date()
  try {
    if (cmd === 'add') {
      const rest = process.argv.slice(4)
      const noConfirm = rest.includes('--no-confirm')
      const onlyIfIdle = rest.includes('--only-if-idle')
      const note = rest.filter((x) => !x.startsWith('--')).join(' ')
      const g = addGrant({ at: a, confirm: noConfirm ? 'none' : 'required', note, onlyIfIdle })
      console.log(JSON.stringify({ ok: true, grant: g }))
    } else if (cmd === 'list') {
      const items = readGrants()
      if (!items.length) console.log('（没有预约）')
      for (const g of items) {
        const local = new Date(g.at).toLocaleString('zh-CN', { hour12: false })
        console.log(`${g.id}  ${local}  confirm=${g.confirm}${g.confirmAt ? '(已确认)' : ''}${g.onlyIfIdle ? ' 空闲才开' : ''}${g.deferred ? ` 已顺延${g.deferred}次` : ''}  ${g.note || ''}`)
      }
    } else if (cmd === 'confirm') {
      const g = confirmGrant(a, now)
      console.log(g ? `已确认 ${g.id}` : `没有这条预约：${a}`)
    } else if (cmd === 'cancel') {
      cancelGrant(a)
      console.log('已取消 ' + a)
    } else {
      console.log('用法: grant.mjs add <HH:MM|+分钟|ISO> [--no-confirm] [备注] | list | confirm <id> | cancel <id>')
      process.exit(1)
    }
  } catch (e) {
    console.error('错误：' + e.message)
    process.exit(1)
  }
}

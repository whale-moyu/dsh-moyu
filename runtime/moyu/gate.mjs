// 摸鱼·入口闸（2026-11-16）
// 三种启动方式（立刻 / 延时 / 定时）共用这一个闸；闸只做「能不能进」，不改进窗口后的任何规矩。
//
// 不降级清单：
//   - 窗口参数（预算/时长）永远来自 config.json；本脚本不传、也不许传。
//   - 前置不过就不进：ACL 已锁 / 磁盘不够 / 已有摸鱼在跑 / config 窗口 ≤0。
//   - 到点先通知，默认要人 confirm；10 分钟不确认就作废（grant.mjs 里判）。
//   - 任何失败只记日志，不重试、不循环（任务每分钟一跳，失败下一跳再判，且有 30 分钟冷却）。

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { evaluate, markUsed, markNotified, deferGrant } from './grant.mjs'

const HOME_DIR = process.env.USERPROFILE || 'C:/Users'
const ROOT = HOME_DIR.replace(/\\/g, '/') + '/.dsh/moyu'
const STATE = path.join(ROOT, 'state.json')
const LOG = path.join(ROOT, 'logs', 'gate.log')
const COOLDOWN = path.join(ROOT, 'logs', 'gate-cooldown.json')
const LAST = path.join(ROOT, 'logs', 'gate-last.json')
const SESSIONS = HOME_DIR.replace(/\\/g, '/') + '/.dsh/sessions'
const QQ_SEND = HOME_DIR.replace(/\\/g, '/') + '/Documents/deepseek-harness/default-workspace/tools/qq-send.mjs'
const NODE = process.execPath
const DRY = process.argv.includes('--dry-run')

function log(line) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true })
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`)
  } catch {}
}

// 每次有结论就落一笔，设置页靠它回答「上次为什么没进」。
// 只记最后一次，不堆积——堆了也没人翻。
function noteLast(obj) {
  try {
    fs.mkdirSync(path.dirname(LAST), { recursive: true })
    fs.writeFileSync(LAST, JSON.stringify({ at: new Date().toISOString(), ...obj }, null, 2), 'utf8')
  } catch {}
}

// 「我还在忙」的判据：最近 N 分钟内有任何会话文件被写过。
// 为什么不问 DSH：闸是独立进程，问它要起 HTTP，还可能被端口变化坑；文件 mtime 最稳。
function recentSessionActivity(minutes = 10) {
  const cutoff = Date.now() - minutes * 60000
  const stack = [SESSIONS]
  let newest = 0
  while (stack.length) {
    const dir = stack.pop()
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { stack.push(p); continue }
      try {
        const m = fs.statSync(p).mtimeMs
        if (m > newest) newest = m
      } catch {}
    }
    if (newest >= cutoff) break // 已经够新，不必扫完
  }
  return newest >= cutoff
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
}

function inCooldown() {
  const c = readJson(COOLDOWN)
  return !!(c && Date.parse(c.until) > Date.now())
}

function setCooldown(min) {
  try {
    fs.mkdirSync(path.dirname(COOLDOWN), { recursive: true })
    fs.writeFileSync(COOLDOWN, JSON.stringify({ until: new Date(Date.now() + min * 60000).toISOString() }))
  } catch {}
}

function ps(script, args) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], {
    encoding: 'utf8',
    timeout: 60000,
  })
  return { code: r.status, out: String(r.stdout || '').trim(), err: String(r.stderr || '').trim() }
}

function preconditions() {
  const st = readJson(STATE) || {}
  if (st.mode === 'moyu') return { ok: false, why: 'already-in-moyu' }

  // ACL 能不能锁：status 里 locked 为真说明已经锁着（异常残留），先不进。
  const acl = ps(path.join(ROOT, 'acl.ps1'), ['status'])
  if (acl.code !== 0) return { ok: false, why: 'acl-status-failed' }
  if (/locked:\s*yes/i.test(acl.out)) return { ok: false, why: 'acl-already-locked' }

  // 磁盘：窗口里要写日记/截图，留 3GB 以上
  try {
    const s = spawnSync('powershell.exe', ['-NoProfile', '-Command', "(Get-PSDrive C).Free"], { encoding: 'utf8', timeout: 15000 })
    const free = Number(String(s.stdout).trim())
    if (Number.isFinite(free) && free < 3 * 1024 ** 3) return { ok: false, why: 'disk-low' }
  } catch {}

  // 窗口参数必须有效（来自 config，不来自预约单）
  const cfg = readJson(path.join(ROOT, 'config.json')) || {}
  const dur = Number(cfg?.window?.durationMinutes ?? 0)
  if (!(dur > 0)) return { ok: false, why: 'bad-window-config' }

  return { ok: true, why: '' }
}

function notify(text) {
  try {
    const tmp = path.join(ROOT, 'logs', 'gate-notify.txt')
    fs.mkdirSync(path.dirname(tmp), { recursive: true })
    fs.writeFileSync(tmp, text, 'utf8')
    if (DRY) { log(`[dry] notify: ${text.replace(/\n/g, ' ')}`); return }
    spawnSync(NODE, [QQ_SEND, '--to', '2479260392', '--text-file', tmp], { encoding: 'utf8', timeout: 30000 })
  } catch (e) {
    log('notify failed: ' + e.message)
  }
}

function enter() {
  const cmd = path.join(ROOT, 'moyu.cmd')
  if (DRY) { log('[dry] would run moyu.cmd enter'); return { ok: true } }
  // 不经 shell 弹窗，直接走 cmd /c；参数一律不给（moyu.ps1 会忽略并记 ignored）
  const r = spawnSync('cmd.exe', ['/c', cmd, 'enter'], { encoding: 'utf8', timeout: 120000 })
  return { ok: r.status === 0, out: String(r.stdout || '').trim(), err: String(r.stderr || '').trim(), code: r.status }
}

function main() {
  if (inCooldown()) { log('skip: cooldown'); return }
  const ev = evaluate()
  if (ev.action === 'idle') return
  const g = ev.grant

  if (ev.action === 'notify') {
    if (!g.notifiedAt) {
      const local = new Date(g.at).toLocaleString('zh-CN', { hour12: false })
      notify(`【摸鱼预约】${local} 到点了。回一句「预约确认 ${g.id}」我就进去，十分钟内没确认就作废。`)
      if (!DRY) markNotified(g.id)
      log(`notify id=${g.id}`)
      noteLast({ action: 'notify', id: g.id, why: 'awaiting-confirm' })
    } else {
      log(`awaiting-confirm id=${g.id}`)
      noteLast({ action: 'awaiting', id: g.id, why: 'awaiting-confirm' })
    }
    return
  }

  // action === 'enter'
  // 空闲条件：单子标了 only-if-idle，而我这会还在写会话 → 顺延，不判死、不冷却。
  if (g.onlyIfIdle && recentSessionActivity(10)) {
    if (!DRY) {
      const d = deferGrant(g.id, 15, 'busy')
      if (!d) { noteLast({ action: 'defer-giveup', id: g.id, why: 'busy-4x' }); return }
      notify(`【摸鱼预约】到点了但我还在忙，顺延到 ${new Date(d.at).toLocaleString('zh-CN', { hour12: false })}（第 ${d.deferred} 次）。`)
    }
    log(`defer id=${g.id} (busy)`)
    noteLast({ action: 'defer', id: g.id, why: 'busy' })
    return
  }

  const pre = preconditions()
  if (!pre.ok) {
    log(`blocked id=${g.id} why=${pre.why}`)
    setCooldown(30)
    notify(`【摸鱼预约】${g.id} 到点了，但前置没过（${pre.why}），没进。`)
    noteLast({ action: 'blocked', id: g.id, why: pre.why, cooldownMin: 30 })
    return
  }
  const r = enter()
  if (r.ok) {
    if (!DRY) markUsed(g.id)
    log(`enter id=${g.id}`)
    notify(`【摸鱼预约】进了（${g.id}）。`)
    noteLast({ action: 'enter', id: g.id, why: 'due' })
  } else {
    log(`enter-failed id=${g.id} code=${r.code} err=${(r.err || '').slice(0, 200)}`)
    setCooldown(30)
    noteLast({ action: 'enter-failed', id: g.id, why: 'enter-failed', detail: (r.err || '').slice(0, 200), cooldownMin: 30 })
  }
}

main()

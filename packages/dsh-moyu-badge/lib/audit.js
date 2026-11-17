// 审计与留痕：拒绝、写入、守卫自身出错、ACL 记录、自动进场的判定结果。
// 拆自 index.js（2026-11-17）。只写文件，不改状态。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const MOYU_DIR = process.env.DSH_MOYU_DIR || path.join(DSH_HOME, 'moyu')
export const FT = path.join(MOYU_DIR, 'freetime')
const GATE_LAST = path.join(MOYU_DIR, 'logs', 'gate-last.json')
const GATE_COOLDOWN = path.join(MOYU_DIR, 'logs', 'gate-cooldown.json')

export function logGuardError(where, err) {
  try {
    const p = path.join(MOYU_DIR, 'freetime', 'guard-error.log')
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.appendFileSync(p, new Date().toISOString() + ' [' + where + '] ' + ((err && err.stack) || err) + '\n', 'utf8')
  } catch {}
}

export function logDenial(name, reason) {
  try {
    const dir = path.join(MOYU_DIR, 'freetime')
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(
      path.join(dir, 'denials.log'),
      JSON.stringify({ ts: new Date().toISOString(), tool: name, reason }) + '\n',
      'utf8',
    )
  } catch (err) {}
}

// 允许写入的留痕：报告要用「它动了哪些文件」，denials 只记拒绝。

export function logWrite(name, filePath) {
  try {
    const dir = path.join(MOYU_DIR, 'freetime')
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(
      path.join(dir, 'file-writes.log'),
      JSON.stringify({ ts: new Date().toISOString(), tool: name, path: String(filePath) }) + '\n',
      'utf8',
    )
  } catch (err) {}
}

// 安全锁记录：acl.ps1 lock 时写 state/acl.json，unlock 时删。设置页用它显示当前是否上锁。

export function readAclRecord() {
  try {
    const p = path.join(MOYU_DIR, 'state', 'acl.json')
    if (!fs.existsSync(p)) return { locked: false, paths: [] }
    const j = JSON.parse(fs.readFileSync(p, 'utf8'))
    return { locked: true, paths: Array.isArray(j.paths) ? j.paths : [], lockedAt: j.lockedAt || null }
  } catch (err) {
    return { locked: false, paths: [] }
  }
}

// 闸的最近一次结论 + 冷却截止时间，设置页显示用。读不到就返回空。

export function readGate() {
  const pick = (p) => {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
  }
  const last = pick(GATE_LAST)
  const cd = pick(GATE_COOLDOWN)
  const until = cd && cd.until ? Date.parse(cd.until) : 0
  return {
    gate: last,
    cooldownUntil: Number.isFinite(until) && until > Date.now() ? new Date(until).toISOString() : null,
  }
}

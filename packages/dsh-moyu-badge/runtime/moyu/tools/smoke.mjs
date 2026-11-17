#!/usr/bin/env node
// 摸鱼插件冒烟测试（2026-11-17）
// 目的：改完代码，别等重启后靠手点才发现坏在哪。一条命令，绿了再重启。
// 用法：node ~/.dsh/moyu/tools/smoke.mjs
// 只读：不写任何插件文件，不改配置。

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const HOME = process.env.USERPROFILE || process.env.HOME
const MOYU = path.join(HOME, '.dsh', 'moyu')
const PLUG = path.join(HOME, '.dsh', 'plugins', 'dsh-moyu-badge')

const results = []
const add = (name, fn) => {
  try {
    const detail = fn()
    results.push({ name, ok: true, detail: detail || 'ok' })
  } catch (err) {
    results.push({ name, ok: false, detail: err.message })
  }
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))

// 1. 语法
for (const f of [path.join(PLUG, 'lib', 'index.js'), path.join(PLUG, 'lib', 'policy.js'), path.join(PLUG, 'lib', 'store.js'), path.join(PLUG, 'lib', 'audit.js'), path.join(PLUG, 'lib', 'http.js'), path.join(PLUG, 'client', 'client.js')]) {
  add('语法 ' + path.basename(f), () => {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' })
    return 'node --check 通过'
  })
}

// 2. 配置
add('config.json', () => {
  const cfg = readJson(path.join(MOYU, 'config.json'))
  const scopes = cfg.scopes || {}
  const names = Object.keys(scopes)
  if (!names.length) throw new Error('一块地盘都没有')
  for (const n of names) {
    const s = scopes[n]
    if (!s.user) throw new Error('地盘 ' + n + ' 没写 user')
    if (!Array.isArray(s.write) || !s.write.length) throw new Error('地盘 ' + n + ' 没写 write')
  }
  const rc = cfg.permissions && cfg.permissions.runCommands
  if (rc === true || rc === 'full') throw new Error('runCommands 还是「全放」：' + rc)
  if (rc !== false && rc !== 'off' && !scopes[rc]) throw new Error('runCommands 指向不存在的地盘：' + rc)
  return names.length + ' 块地盘，run=' + rc
})

// 3. 状态（可能不存在）
add('state.json', () => {
  const p = path.join(MOYU, 'state.json')
  if (!fs.existsSync(p)) return '没有（没进过摸鱼，跳过）'
  const st = readJson(p)
  if (!st || typeof st.mode !== 'string') throw new Error('没有 mode 字段')
  return 'mode=' + st.mode
})

// 4. 卫士名单
add('guard.json', () => {
  const g = readJson(path.join(MOYU, 'tools', 'guard.json'))
  const apps = (g.allowApps || []).map((x) => String(x).toLowerCase())
  const bad = apps.filter((x) => /edge|chrome|firefox|explorer/.test(x))
  if (bad.length) throw new Error('allowApps 里还有浏览器/资源管理器：' + bad.join(','))
  return 'allowApps ' + apps.length + ' 个，无浏览器'
})

// 5. 关键文件在
add('关键文件', () => {
  const need = [
    ['lib/index.js', path.join(PLUG, 'lib', 'index.js')],
    ['client/client.js', path.join(PLUG, 'client', 'client.js')],
  ['lib/policy.js', path.join(PLUG, 'lib', 'policy.js')],
  ['lib/store.js', path.join(PLUG, 'lib', 'store.js')],
  ['lib/audit.js', path.join(PLUG, 'lib', 'audit.js')],
  ['lib/http.js', path.join(PLUG, 'lib', 'http.js')],
    ['run-as.ps1', path.join(MOYU, 'run-as.ps1')],
    ['run-web.ps1', path.join(MOYU, 'run-web.ps1')],
    ['web-proxy.mjs', path.join(MOYU, 'web-proxy.mjs')],
    ['tools/desktop.ps1', path.join(MOYU, 'tools', 'desktop.ps1')],
    ['tools/activity-report.mjs', path.join(MOYU, 'tools', 'activity-report.mjs')],
    ['tools/report-selftest.mjs', path.join(MOYU, 'tools', 'report-selftest.mjs')],
    ['tools/diary-close.mjs', path.join(MOYU, 'tools', 'diary-close.mjs')],
    ['tools/exit-audit.mjs', path.join(MOYU, 'tools', 'exit-audit.mjs')],
    ['摸鱼手册.md', path.join(MOYU, '摸鱼手册.md')],
    ['边界模板.md', path.join(MOYU, '边界模板.md')],
    ['摸鱼模式-人话版.md', path.join(MOYU, '摸鱼模式-人话版.md')],
  ]
  const miss = need.filter(([, p]) => !fs.existsSync(p)).map(([n]) => n)
  if (miss.length) throw new Error('缺：' + miss.join(', '))
  return need.length + ' 个都在'
})

// 6. PS1 的 BOM（PS 5.1 按 ANSI 读中文会炸）
add('ps1 BOM', () => {
  const files = fs.readdirSync(MOYU).filter((f) => f.endsWith('.ps1'))
    .map((f) => path.join(MOYU, f))
    .concat(fs.readdirSync(path.join(MOYU, 'tools')).filter((f) => f.endsWith('.ps1')).map((f) => path.join(MOYU, 'tools', f)))
  const bad = []
  for (const f of files) {
    const b = fs.readFileSync(f).subarray(0, 3)
    if (!(b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf)) bad.push(path.basename(f))
  }
  if (bad.length) throw new Error('没有 BOM：' + bad.join(', '))
  return files.length + ' 个都有 BOM'
})

// 7. 插件源码里的隔离标记（改坏了能立刻看出来）
add('隔离标记', () => {
  // 拆成 index / policy / store 三个文件之后，标记散在各处，合起来查
  const src = ['index.js', 'policy.js', 'store.js', 'audit.js', 'http.js']
    .map((f) => fs.readFileSync(path.join(PLUG, 'lib', f), 'utf8'))
    .join('\n')
  const need = ['function safeTool(', 'function registerTool(', 'function runSelfCheck(', 'function readConfigFallback(', 'function stateFallback(', 'function logGuardError(']
  const miss = need.filter((k) => !src.includes(k))
  if (miss.length) throw new Error('缺：' + miss.join(', '))
  const reg = (src.match(/registerTool\(ctx, /g) || []).length
  if (reg < 7) throw new Error('走 registerTool 的工具只有 ' + reg + ' 个（应该 ≥7）')
  return reg + ' 个工具走了统一注册'
})

// 输出
let bad = 0
for (const r of results) {
  if (!r.ok) bad++
  console.log((r.ok ? '✓ ' : '✗ ') + r.name + ' — ' + r.detail)
}
console.log('')
console.log(bad === 0 ? '冒烟通过：' + results.length + ' 项' : '冒烟失败：' + bad + ' / ' + results.length + ' 项')
process.exit(bad === 0 ? 0 : 1)

#!/usr/bin/env node
// session-guard.mjs —— DSH 会话完整性巡检（C3，2026-11-09 夜班）
//
// 为什么要有：11-08 那次「工作区全空」不是数据丢了，是 registry 里 11 条
// sessionId 在磁盘上一个文件都没有；而 DSH 启动时会按磁盘反剪 registry，
// 于是越剪越空。这个脚本只读+报，不动任何文件，用来在开机/定时时立刻发现
// 「注册表与磁盘不一致」「会话文件解不开」「cwd 与目录名对不上」。
//
// 检查项（每条会话）：
//   1. registry 能解析、结构正确
//   2. 目录 = sessions/<projectKey(workspace.path)>/<sessionId>
//   3. session.v4.jsonl.zstd 存在且非空
//   4. 第一帧是合法 zstd，解出来是单行 JSON，以 \n 结尾，含 cwd
//   5. projectKey(header.cwd) === 目录名（防止搬会话没改 header）
//   6. 整文件逐帧解压后每一行都能 JSON.parse
// 另报：磁盘上存在但 registry 里没有的会话（只警告，不算错）
//
// 用法：
//   node session-guard.mjs               # 巡检，退出码 0 全好 / 2 有问题
//   node session-guard.mjs --json        # 额外打印 JSON
//   node session-guard.mjs --alarm       # 有问题时发 QQ 给用户
//   node session-guard.mjs --alarm-dry   # 只打印会发出去的话，不发
//   node session-guard.mjs --only <id>   # 只查一条（造坏测试用）
//   node session-guard.mjs --sessions <dir> --registry <file>  # 测试用替换路径

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'
import { execFileSync } from 'node:child_process'

const HOME = os.homedir()
const DSH = path.join(HOME, '.dsh')
const LOG = path.join(DSH, 'moyu', 'tools', 'session-guard.log')
const QQSEND = path.join(HOME, 'Documents', 'deepseek-harness', 'default-workspace', 'tools', 'qq-send.mjs')
const OWNER = '2479260392'
const MAGIC = 0xfd2fb528 // 文件里是字节 28 b5 2f fd，按 UInt32LE 读就是 0xfd2fb528

const argv = process.argv.slice(2)
const has = (k) => argv.includes(`--${k}`)
const pick = (k, d) => {
  const i = argv.indexOf(`--${k}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}
const REGISTRY = pick('registry', path.join(DSH, 'storages', 'workspace.json'))
const SESSIONS = pick('sessions', path.join(DSH, 'sessions'))
const ONLY = pick('only', '')
const wantJson = has('json')

// 与 dsh-workspace-session-drag 的 projectKey() 同规则：
// 盘符后的冒号与所有分隔符折叠成 '-'，两头包 '--'
export function projectKey(p) {
  let s = String(p || '').trim()
  s = s.replace(/^([A-Za-z]):/, '$1') // C:\x -> C\x
  s = s.replace(/[\\/]+/g, '-')
  s = s.replace(/[^A-Za-z0-9._-]/g, '-')
  s = s.replace(/-+/g, '-').replace(/^-|-$/g, '')
  return `--${s}--`
}

function frameSlices(buf) {
  const out = []
  let pos = 0
  while (pos < buf.length) {
    if (buf.length - pos < 4) { out.push([pos, buf.length, 'trailing']); break }
    if (buf.readUInt32LE(pos) !== MAGIC) { out.push([pos, buf.length, 'no-magic']); break }
    let i = pos + 4
    while (i + 3 < buf.length && buf.readUInt32LE(i) !== MAGIC) i++
    if (i + 3 >= buf.length) i = buf.length
    out.push([pos, i, 'ok'])
    pos = i
  }
  return out
}

function checkSession(wsPath, id) {
  const dirName = projectKey(wsPath)
  const file = path.join(SESSIONS, dirName, id, 'session.v4.jsonl.zstd')
  const r = { ws: wsPath, id, file, ok: true, problems: [] }
  const bad = (m) => { r.ok = false; r.problems.push(m) }

  if (!fs.existsSync(file)) { bad('文件不存在'); return r }
  const st = fs.statSync(file)
  r.bytes = st.size
  if (st.size === 0) { bad('文件为 0 字节'); return r }

  let buf
  try { buf = fs.readFileSync(file) } catch (e) { bad('读不出：' + e.message); return r }

  const slices = frameSlices(buf)
  if (!slices.length || slices[0][2] !== 'ok') { bad('第一帧不是合法 zstd 头'); return r }
  r.frames = slices.length

  // 第一帧 = header
  let headerText
  try {
    headerText = zlib.zstdDecompressSync(buf.subarray(slices[0][0], slices[0][1])).toString('utf8')
  } catch (e) { bad('第一帧解压失败：' + e.message); return r }
  if (!headerText.endsWith('\n')) bad('header 帧没有以 \\n 结尾（帧边界可能落在行中间）')
  let header
  try { header = JSON.parse(headerText.trim()) } catch (e) { bad('header 不是合法 JSON：' + e.message); return r }
  if (!header.cwd) bad('header 缺 cwd')
  else {
    r.cwd = header.cwd
    const k2 = projectKey(header.cwd)
    if (k2 !== dirName) bad(`cwd 与目录名不符：cwd->${k2}，目录->${dirName}`)
  }

  // 逐帧解压、逐行 parse
  let lines = 0
  let badLines = 0
  for (let i = 1; i < slices.length; i++) {
    const [a, b, kind] = slices[i]
    if (kind !== 'ok') { bad(`第 ${i} 帧之后找不到 zstd 魔数（偏移 ${a}）`); break }
    let txt
    try { txt = zlib.zstdDecompressSync(buf.subarray(a, b)).toString('utf8') }
    catch (e) { bad(`第 ${i} 帧解压失败：${e.message}`); break }
    const parts = txt.split('\n')
    for (const ln of parts) {
      if (!ln.trim()) continue
      lines++
      try { JSON.parse(ln) } catch { badLines++ }
    }
  }
  r.lines = lines
  if (badLines) bad(`${badLines} 行不是合法 JSON`)
  return r
}

function main() {
  const res = { at: new Date().toISOString(), registry: REGISTRY, sessions: SESSIONS, workspaces: [], results: [], warnings: [], errors: 0 }

  let reg
  try { reg = JSON.parse(fs.readFileSync(REGISTRY, 'utf8')) } catch (e) {
    res.errors++
    res.results.push({ ok: false, problems: ['registry 读不出：' + e.message] })
    return finish(res)
  }

  // 真实结构：{ unit, global, tables: { workspaces: { <uuid>: {path,title,sessionIds,...} } } }
  // 也兼容旧/测试里的 workspaces 数组
  const wsTable = reg?.tables?.workspaces
  const wsList = Array.isArray(wsTable)
    ? wsTable
    : wsTable && typeof wsTable === 'object'
      ? Object.entries(wsTable).map(([id, w]) => ({ id, ...(w || {}) }))
      : Array.isArray(reg.workspaces) ? reg.workspaces : []
  if (!wsList.length) { res.errors++; res.warnings.push('registry 里找不到任何 workspace（结构可能变了）') }
  const registered = new Set()
  for (const ws of wsList) {
    if (!ws || typeof ws !== 'object') { res.errors++; res.warnings.push('registry 里有非对象 workspace'); continue }
    if (!ws.path) { res.errors++; res.warnings.push(`workspace ${ws.id || '?'} 缺 path`); continue }
    if (!Array.isArray(ws.sessionIds)) { res.errors++; res.warnings.push(`workspace ${ws.id || '?'} 缺 sessionIds 数组`); continue }
    res.workspaces.push({ id: ws.id, name: ws.title, path: ws.path, count: ws.sessionIds.length })
    for (const id of ws.sessionIds) {
      registered.add(`${projectKey(ws.path)}/${id}`)
      if (ONLY && id !== ONLY) continue
      const r = checkSession(ws.path, id)
      res.results.push(r)
      if (!r.ok) res.errors++
    }
  }

  // 磁盘上多出来的（未注册）
  if (!ONLY) {
    let dirs = []
    try { dirs = fs.readdirSync(SESSIONS, { withFileTypes: true }).filter(d => d.isDirectory()) } catch {}
    for (const d of dirs) {
      let subs = []
      try { subs = fs.readdirSync(path.join(SESSIONS, d.name), { withFileTypes: true }).filter(x => x.isDirectory()) } catch {}
      for (const s of subs) {
        const key = `${d.name}/${s.name}`
        if (!registered.has(key)) {
          const f = path.join(SESSIONS, d.name, s.name, 'session.v4.jsonl.zstd')
          const sz = fs.existsSync(f) ? fs.statSync(f).size : 0
          res.warnings.push(`未注册会话：${key}（${sz} 字节）`)
        }
      }
    }
  }
  return finish(res)
}

function finish(res) {
  const total = res.results.length
  const ok = res.results.filter(r => r.ok).length
  const badOne = res.results.filter(r => !r.ok)
  const stamp = new Date().toLocaleString('sv-SE')
  const lines = [
    `[${stamp}] session-guard total=${total} ok=${ok} bad=${badOne.length} warnings=${res.warnings.length}`,
    ...badOne.map(r => `  BAD ${r.id || '(registry)'} @ ${r.ws || ''}: ${r.problems.join('；')}`),
    ...res.warnings.map(w => `  WARN ${w}`),
  ]
  const report = lines.join('\n')
  try { fs.appendFileSync(LOG, report + '\n') } catch {}
  console.log(report)
  if (wantJson) console.log(JSON.stringify(res, null, 2))

  if (res.errors > 0) {
    const msg = [
      `⚠️ 会话巡检发现问题：${badOne.length} 条坏，${res.warnings.length} 条警告`,
      ...badOne.slice(0, 5).map(r => `- ${r.id}：${r.problems[0]}`),
      `详情：~/.dsh/moyu/tools/session-guard.log`,
    ].join('\n')
    if (has('alarm-dry')) {
      console.log('--- 会发给用户的 QQ ---')
      console.log(msg)
    } else if (has('alarm')) {
      try {
        fs.writeFileSync(path.join(DSH, 'tmp', 'session-guard-alarm.txt'), msg, 'utf8')
        execFileSync(process.execPath, [QQSEND, '--to', OWNER, '--text-file', path.join(DSH, 'tmp', 'session-guard-alarm.txt')], { timeout: 20000, stdio: 'ignore' })
        console.log('已发 QQ 报警')
      } catch (e) { console.log('QQ 报警发送失败：' + e.message) }
    }
    process.exit(2)
  }
  process.exit(0)
}

main()

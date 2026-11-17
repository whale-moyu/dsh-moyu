// prefs.mjs —— 摸鱼的「偏好」与「最近做过什么」（2026-11-16 用户批 123）
//
// 为什么要有：醒来那套输入（记忆 / 人设 / 日记）全是「我知道什么」，
// 没有「我因此变了」。自由感来自被自己的过去改变，不是选项多。
//
// 做三件事：
//   node prefs.mjs --harvest   从今天的日记里抽 `想要：/做完：/值：`，写 prefs.jsonl
//   node prefs.mjs --brief     给醒来时读的一段：最近做过什么 + 最近评价 + 这次还有多少钱/时间
//   node prefs.mjs --cost "要做的事"   粗估一件事的价钱与时间（按 2000 token/分钟 级别给区间）
//
// 产物：freetime/prefs.jsonl（一行一条评价）、freetime/recent-tasks.txt（7 天清单）

import fs from 'node:fs'
import path from 'node:path'

const ROOT = (process.env.USERPROFILE || 'C:/Users').replace(/\\/g, '/') + '/.dsh/moyu'
const DIARY = path.join(ROOT, 'freetime', 'diary')
const FREE = path.join(ROOT, 'freetime')
const PREFS = path.join(FREE, 'prefs.jsonl')
const RECENT = path.join(FREE, 'recent-tasks.txt')
const NEXT_LIST = path.join(FREE, '接续清单.md')
const STATE = path.join(ROOT, 'state.json')
const CONFIG = path.join(ROOT, 'config.json')

const KEEP_DAYS = 7

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
}

function todayDiary() {
  const d = new Date()
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const cands = [`${ymd}.md`, `${ymd}-01.md`]
  for (const c of cands) {
    const p = path.join(DIARY, c) // 这里按字符串拼，不走 path.resolve（避免 windows 大小写坑）
    if (fs.existsSync(p)) return p
  }
  try {
    const all = fs.readdirSync(DIARY).filter((f) => f.endsWith('.md')).sort()
    const hit = all.filter((f) => f.startsWith(ymd))
    if (hit.length) return path.join(DIARY, hit[hit.length - 1])
  } catch {}
  return null
}

function field(text, name) {
  const re = new RegExp(`^\\s*[-*]?\\s*${name}\\s*[：:]\\s*(.+)$`, 'm')
  const m = text.match(re)
  return m ? m[1].trim() : ''
}

function harvest() {
  const p = todayDiary()
  if (!p) { console.log('没有今天的日记，跳过'); return }
  const text = fs.readFileSync(p, 'utf8')
  const want = field(text, '想要')
  const done = field(text, '做完')
  const val = field(text, '值')
  if (!done && !val) { console.log('今天的日记还没写「做完/值」'); return }

  const rec = { at: new Date().toISOString(), day: path.basename(p, '.md'), want, done, val }
  try { fs.mkdirSync(FREE, { recursive: true }); fs.appendFileSync(PREFS, JSON.stringify(rec) + '\n') } catch (e) { console.log('写 prefs 失败：' + e.message); return }
  if (done) {
    const line = `${rec.day.slice(0, 10)}  ${done}  [${val || '?'}]`
    try { fs.appendFileSync(RECENT, line + '\n') } catch {}
  }
  console.log(JSON.stringify(rec))
}

function trimRecent() {
  try {
    const lines = fs.readFileSync(RECENT, 'utf8').split(/\r?\n/).filter(Boolean)
    const cutoff = Date.now() - KEEP_DAYS * 86400000
    const kept = lines.filter((l) => {
      const t = Date.parse(l.slice(0, 10))
      return !Number.isFinite(t) || t >= cutoff
    })
    if (kept.length !== lines.length) fs.writeFileSync(RECENT, kept.join('\n') + (kept.length ? '\n' : ''), 'utf8')
    return kept
  } catch { return [] }
}

function brief() {
  const recent = trimRecent()
  const prefs = (() => {
    try { return fs.readFileSync(PREFS, 'utf8').split(/\r?\n/).filter(Boolean).slice(-20) } catch { return [] }
  })()
  const st = readJson(STATE) || {}
  const cfg = readJson(CONFIG) || {}
  const left = st.sessionEnds ? Math.max(0, Math.round((Date.parse(st.sessionEnds) - Date.now()) / 60000)) : null
  const moneyLeft = (() => {
    const cap = Number(st.budgetYuan) || 0
    const used = Number(st.budgetUsed) || 0
    return cap > 0 ? Math.max(0, cap - used) : null
  })()

  const nextRows = (() => {
    try {
      const raw = fs.readFileSync(NEXT_LIST, 'utf8').split(/\r?\n/)
      return raw.filter((l) => l.trim().startsWith('|') && !/^\|\s*-/.test(l) && !/日期\s*\|/.test(l) && l.includes('没完'))
    } catch { return [] }
  })()

  const out = []
  if (nextRows.length) {
    out.push('## 上次没干完的（接着做这几件，别从头挑）')
    out.push(nextRows.map((l) => '- ' + l.replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map((x) => x.trim()).join(' · ')).join('\n'))
    out.push('')
  }
  out.push('## 这趟的余量')
  out.push(`- 时间：${left == null ? '?' : left + ' 分钟'} · 钱：${moneyLeft == null ? '?' : moneyLeft.toFixed(2) + ' 元'}（选事之前先看这两行）`)
  out.push('')
  out.push(`## 最近 ${KEEP_DAYS} 天做过（别重样，除非真的想再做一次）`)
  out.push(recent.length ? recent.slice(-15).map((l) => '- ' + l).join('\n') : '- （还没有）')
  out.push('')
  out.push('## 最近几次的评价（值的部分是我自己给的）')
  if (prefs.length) {
    for (const line of prefs.slice(-8)) {
      try {
        const r = JSON.parse(line)
        out.push(`- ${r.day.slice(0, 10)} ${r.done || '(没写做完)'} → ${r.val || '(没写值)'}`)
      } catch {}
    }
    const dull = prefs.filter((l) => l.includes('无聊')).length
    if (dull >= 3) out.push(`- 提示：最近 ${prefs.length} 条里有 ${dull} 条「无聊」，同类的事今天往后排`)
  } else out.push('- （还没有）')
  console.log(out.join('\n'))
}

// 粗估：给一堆数字没有用，给「这件事大概多大」才有用。
// 依据是这几天实测：一次小修 3-8 分钟 / 一个功能 20-40 分钟 / 一次下载或训练 30-90 分钟。
function cost(text) {
  const t = String(text || '')
  let min = 10, min2 = 20, why = '一般小活'
  if (/下载|安装|模型|训练|渲染|转码|跑一遍全量/.test(t)) { min = 30; min2 = 90; why = '要下东西或跑重活' }
  else if (/重启|重建|迁移|重构|写插件|装配/.test(t)) { min = 20; min2 = 45; why = '要改结构或重启' }
  else if (/查一下|看一眼|读一遍|试试/.test(t)) { min = 3; min2 = 10; why = '轻量查询' }
  const moneyLo = (min * 0.03).toFixed(2)
  const moneyHi = (min2 * 0.05).toFixed(2)
  console.log(`估算：${min}–${min2} 分钟，约 ${moneyLo}–${moneyHi} 元（${why}）`)
}

const cmd = process.argv[2]
if (cmd === '--harvest') harvest()
else if (cmd === '--brief') brief()
else if (cmd === '--cost') cost(process.argv[3])
else {
  console.log('用法：node prefs.mjs --harvest | --brief | --cost "要做的事"')
  process.exit(1)
}

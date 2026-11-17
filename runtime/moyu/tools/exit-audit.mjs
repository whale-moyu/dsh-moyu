// exit-audit.mjs —— 退出审计：把三份记录对一遍，找「说做了但没做」
//
// 为什么要有：摸鱼退出时，日记说「玩了 40 分钟」、sessions.log 说 actions=0、
// autonomy 审计里一条都没有——三份各说各的，谁也不知道哪份是真的。
// 这个脚本只做对照，不改任何文件。
//
//   node tools/exit-audit.mjs            看今天
//   node tools/exit-audit.mjs 2026-11-16 看某天
//   node tools/exit-audit.mjs --all      看最近 7 天

import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.env.USERPROFILE + '/.dsh'
const MOYU = path.join(ROOT, 'moyu')
const FREE = path.join(MOYU, 'freetime')
const SESSIONS = path.join(FREE, 'sessions.log')
const DIARY_DIR = path.join(FREE, 'diary')
const AUDIT = path.join(ROOT, 'autonomy-audit.jsonl')
const GUARDLOG = path.join(MOYU, 'logs', 'guard.log')

const dayOf = (iso) => {
  const d = new Date(iso)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const readJsonl = (file) => {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => {
      try { return JSON.parse(l) } catch { return null }
    }).filter(Boolean)
  } catch { return [] }
}

const sectionsOf = (day) => {
  const f = path.join(DIARY_DIR, day + '.md')
  let txt = ''
  try { txt = fs.readFileSync(f, 'utf8') } catch { return null }
  const secs = txt.match(/^##\s+\d{1,2}:\d{2}/gm) || []
  return { file: f, count: secs.length, placeholders: (txt.match(/自动记录（待改写）/g) || []).length, bytes: txt.length }
}

function auditDay(day) {
  // 跨零点的窗口：23:59 进、00:00 出，日记会写在第二天，sessions.log 记的是第一天。
  // 所以「属于这一天」包括开始那天和结束那天——不然每次跨零点都要报一次假警。
  const sessions = readJsonl(SESSIONS).filter((s) => {
    const startDay = (s.startedAt || '').slice(0, 10)
    const endDay = s.endedAt ? dayOf(s.endedAt) : startDay
    return startDay === day || endDay === day
  })
  const audit = readJsonl(AUDIT).filter((a) => (a.ts || '').startsWith(day) || dayOf(a.ts) === day)
  const guardLines = (() => {
    try {
      return fs.readFileSync(GUARDLOG, 'utf8').split(/\r?\n/).filter((l) => l.startsWith(day))
    } catch { return [] }
  })()
  const diary = sectionsOf(day)

  const problems = []
  const mins = sessions.reduce((n, s) => n + (Number(s.durMin) || 0), 0)
  const actions = sessions.reduce((n, s) => n + (Number(s.actions) || 0), 0)

  if (sessions.length && !diary) problems.push('有摸鱼窗口，但那天没有日记文件')
  if (sessions.length && diary && diary.count === 0) problems.push('有摸鱼窗口，日记里一个段落都没有')
  if (diary && diary.count > 0 && !sessions.length) problems.push('日记里有段落，sessions.log 里没有这次的记录')
  if (sessions.length && actions === 0 && mins > 10) problems.push(`窗口 ${mins} 分钟，但 sessions.log 记的动作数是 0（收尾没挂上或没真的动过）`)
  if (diary && diary.placeholders > 0) problems.push(`日记里还有 ${diary.placeholders} 段「自动记录（待改写）」没改写`)
  // autonomy 审计空不空，不当问题报。
  // 理由：凡是没用 autonomy 系列工具跑流程的窗口，这份审计一定是空的——玩游戏、验证边界都不会写它。
  // 2026-11-17 这一天就是这么被误报的：81 次桌面动作、0 条 autonomy，警告一直亮着。
  // 需要看的时候用日志那一行的条数就行，不影响判定。

  return { day, sessions, audit, guardLines, diary, mins, actions, problems }
}

const args = process.argv.slice(2)
const days = (() => {
  if (args.includes('--all')) {
    const set = new Set()
    for (const s of readJsonl(SESSIONS)) if (s.startedAt) set.add(s.startedAt.slice(0, 10))
    for (const a of readJsonl(AUDIT)) if (a.ts) set.add(dayOf(a.ts))
    try {
      for (const f of fs.readdirSync(DIARY_DIR)) if (/^\d{4}-\d{2}-\d{2}\.md$/.test(f)) set.add(f.slice(0, 10))
    } catch {}
    return [...set].sort().slice(-7)
  }
  const d = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a))
  if (d) return [d]
  const now = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return [`${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`]
})()

let bad = 0
for (const day of days) {
  const r = auditDay(day)
  console.log(`\n## ${day}`)
  console.log(`- 摸鱼窗口：${r.sessions.length} 次，共 ${r.mins} 分钟，动作 ${r.actions} 次`)
  console.log(`- 日记：${r.diary ? `${r.diary.count} 段 · ${r.diary.bytes} 字节 · ${r.diary.placeholders} 段待改写` : '没有文件'}`)
  console.log(`- autonomy 审计：${r.audit.length} 条`)
  console.log(`- 守夜人日志：${r.guardLines.length} 行`)
  if (r.problems.length) {
    bad += r.problems.length
    for (const p of r.problems) console.log(`  ⚠ ${p}`)
  } else {
    console.log('  ✓ 三份对得上')
  }
}

console.log(bad ? `\n共 ${bad} 处对不上。这些都只是「对不上」，不是「一定有问题」——先看是哪一份缺。` : '\n三份都对得上。')
process.exit(bad ? 1 : 0)

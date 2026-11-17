#!/usr/bin/env node
// 报告自检：喂一段「我确定内容」的假记录，核对 activity-report.mjs 输出的数字。
// 为什么要有这个：2026-11-17 一天里连着发现三处「报告在说谎」（动作数恒 0、退出方式写英文、
// 日记行数读错路径），全靠 doctor 报警才看见。这里把「已知输入 → 期望数字」钉死，
// 改坏就当场红，不用等到下次有人看报告。
//
// 用法：node tools/report-selftest.mjs
// 退出码：0 全对；1 有对不上的（会逐条列出期望与实际）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const SELF = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const REPORT = path.join(SELF, 'activity-report.mjs')

const S = '2026-11-17T10:00:00+08:00'
const E = '2026-11-17T10:30:00+08:00'
const L = (h, m, s = 0) => `2026-11-17 ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-report-selftest-'))
const dsh = path.join(tmp, '.dsh')
const moyu = path.join(dsh, 'moyu')
const ft = path.join(moyu, 'freetime')
for (const d of [path.join(moyu, 'logs'), ft, path.join(moyu, 'tools'), path.join(dsh, 'tools'), path.join(ft, 'diary')]) {
  fs.mkdirSync(d, { recursive: true })
}

const W = (p, body) => fs.writeFileSync(p, body, 'utf8')

W(path.join(moyu, 'state.json'), JSON.stringify({ mode: 'code', sessionStarted: S, budgetUsed: 0.5, budgetYuan: 35 }))

// 1) 工具调用 5 次（guard-seen.log）
W(path.join(moyu, 'logs', 'guard-seen.log'), [
  '2026-11-17T02:01:00.000Z read',
  '2026-11-17T02:02:00.000Z write',
  '2026-11-17T02:03:00.000Z moyu_run',
  '2026-11-17T02:04:00.000Z moyu_desktop',
  '2026-11-17T02:05:00.000Z pwsh',
  '',
].join('\n'))

// 2) 被拒 2 次（denials.log，JSON 行）
W(path.join(ft, 'denials.log'), [
  JSON.stringify({ ts: '2026-11-17T02:06:00.000Z', tool: 'pwsh', reason: 'tool-not-allowed' }),
  JSON.stringify({ ts: '2026-11-17T02:07:00.000Z', tool: 'write', reason: 'boundary-write' }),
  '',
].join('\n'))

// 3) 写 1 个文件
W(path.join(ft, 'file-writes.log'), JSON.stringify({ ts: '2026-11-17T02:08:00.000Z', tool: 'write', path: path.join(ft, 'note.md') }) + '\n')

// 4) 起 2 次程序（run.log 在 dsh/tools 下）
W(path.join(dsh, 'tools', 'run.log'), [
  JSON.stringify({ ts: '2026-11-17T02:09:00.000Z', exe: 'C:\\x\\node.exe', ok: true }),
  JSON.stringify({ ts: '2026-11-17T02:10:00.000Z', exe: 'C:\\x\\node.exe', ok: false, timedOut: true }),
  '',
].join('\n'))

// 5) 鼠标键盘：放行 3 次、被拒 1 次
W(path.join(moyu, 'tools', 'actions.log'), [
  `${L(10, 1)} click {"X":1,"Y":2}`,
  `${L(10, 2)} REFUSED click {"X":3,"Y":4}`,
  `${L(10, 3)} shot {"Out":"a.png"}`,
  `${L(10, 4)} key tab`,
  '',
].join('\n'))

// 6) 上网：放行 2 个站点、拒绝 1
W(path.join(ft, 'web-access.log'), [
  '2026-11-17T02:11:00.000Z ALLOW example.com:443',
  '2026-11-17T02:12:00.000Z ALLOW bing.com:443',
  '2026-11-17T02:13:00.000Z DENY 127.0.0.1:52631',
  '',
].join('\n'))

// 7) 日记：3 行（含空行不算）
W(path.join(ft, 'diary', '2026-11-17.md'), '# 日记\n\n第一行\n第二行\n')

// 8) 会话记录 1 条：30 分钟、12 个动作
W(path.join(ft, 'sessions.log'), JSON.stringify({
  startedAt: S, endedAt: E, durMin: 30, actions: 12, wakes: 1, incidents: 0, playMin: 0,
  budgetUsed: 0.5, budgetYuan: 35, reason: 'manual',
}) + '\n')

let ok = true
const fail = (what, want, got) => { ok = false; console.log(`  ✗ ${what}：期望 ${want}，实际 ${got}`) }
const want = (what, wantText, hay) => {
  if (!hay.includes(wantText)) fail(what, `包含「${wantText}」`, '没找到')
}

try {
  const out = execFileSync(process.execPath, [REPORT, '--since', S, '--to', E, '--quiet'], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, AK_DSH_HOME: dsh, AK_MOYU_HOME: moyu },
  })
  const rep = fs.readdirSync(path.join(ft, 'reports')).filter((f) => f.endsWith('.md')).sort().pop()
  if (!rep) throw new Error('报告没生成')
  const txt = fs.readFileSync(path.join(ft, 'reports', rep), 'utf8')
  // 报告正文里不该出现 NaN / undefined
  if (/NaN|undefined|null/.test(txt)) fail('正文出现 NaN/undefined/null', '无', '有')

  want('工具调用次数', '工具调用 5 次', txt)
  want('被拒次数', '被拒 2 次', txt)
  want('起程序次数', '起了 2 次程序', txt)
  want('桌面放行', '放行 3 次，被拒 1 次', txt)
  want('上网站点数', '上了 2 个网站', txt)
  want('退出方式中文', '退出方式：主人手动退出', txt)
  want('日记行数', '3 行', txt)
  want('会话动作数', '12 个动作', txt)
  want('会话时长', '30 分钟', txt)
} catch (e) {
  ok = false
  console.log('  ✗ 跑报告失败：' + (e && e.message))
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

if (ok) console.log('报告自检：全对（工具 5 / 被拒 2 / 程序 2 / 桌面 3+1 / 网站 2 / 日记 3 / 会话 30 分钟 12 动作）')
process.exit(ok ? 0 : 1)

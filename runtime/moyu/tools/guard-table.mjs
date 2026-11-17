// 守卫判定的表驱动测试（2026-11-17）。
// 目的：把「摸鱼时这个工具/这条路径准不准」的规则钉死——守卫是出事就全废的地方，
// 今天四次连带故障里有三次出在这套判定上。
//
// 说明：判定里的纯规则都在 policy.js（MOYU_BAN / allowedTool / readBoundaries /
// readDeniedHit / toolPaths / underRoot / passOk / strictOf）。index.js 的
// ctx.tools.guard 只是按固定顺序调用它们，并在命中后做副作用（记日志、判篡改退出）。
// 这里测规则本身；顺序不变式在末尾单独断言。
//
// 跑法：node ~/.dsh/moyu/tools/guard-table.mjs
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const LIB = path.join(os.homedir(), '.dsh', 'plugins', 'dsh-moyu-badge', 'lib')
const POLICY_URL = pathToFileURL(path.join(LIB, 'policy.js')).href
const P = await import(POLICY_URL)

let fail = 0
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) fail++
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (ok ? '' : ` → ${JSON.stringify(got)} 期望 ${JSON.stringify(want)}`))
}

// 真配置同形（失败关闭那套：跑/联 都要显式开）
const cfgBase = () => ({
  permissions: { runCommands: 'games', networkReadonly: true, social: 'owner', desktopControl: true },
  scopes: {
    playground: { label: '游乐场', write: ['~/AkPlay'], run: ['node', 'python', 'py'], net: false, timeoutMs: 60000, user: 'moyu' },
    games: { label: '玩游戏', write: ['~/AkPlay'], run: [], net: false, timeoutMs: 3600000, user: 'moyu' },
  },
  allow: {},
  paths: { readDenied: ['C:\\Users\\Administrator\\.dsh\\qq-console.json', 'C:\\Users\\Administrator\\.dsh\\storages'] },
})
const stBase = () => ({ mode: 'moyu', boundaries: {} })

// ── 1. 白名单 ──────────────────────────────────────────────────────────
{
  const cfg = cfgBase()
  const allow = ['read', 'grep', 'glob', 'ops_read_files', 'write', 'edit', 'todo_write', 'ask_user_question',
    'memory_read', 'memory_search', 'schedule_list', 'schedule_view', 'compress', 'decompress',
    'acp_status', 'acp_cache', 'present', 'read_image', 'web_fetch', 'web_search',
    'moyu_run', 'moyu_fetch', 'moyu_desktop', 'moyu_boundary', 'moyu_exit', 'moyu_web',
    'mcp__snowluma__qq_get_unread_messages', 'mcp__snowluma__qq_send_message']
  for (const n of allow) eq('放行 ' + n, P.allowedTool(n, cfg), true)

  const deny = ['pwsh', 'bash', 'ops_bash', 'plugin_manager', 'subagent', 'subagent_fork', 'workflow',
    'generate_image', 'sense_now', 'video_index', 'office_convert', 'sound_read',
    'mcp__github__create_issue', 'bili_post_dynamic', 'who_am_i_unknown_tool']
  for (const n of deny) eq('拒绝 ' + n, P.allowedTool(n, cfg), false)
}

// ── 2. 额外放行（走 allow-extra.json 那条路；模块带 5 秒缓存，所以放子进程里测）──
{
  const probe = `
    const P = await import(${JSON.stringify(POLICY_URL)});
    const cfg = { allow: { extraTools: ['sound_read'] } };
    console.log(JSON.stringify([P.allowedTool('sound_read', cfg), P.allowedTool('office_convert', cfg)]));
  `
  try {
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', probe], { encoding: 'utf8', timeout: 20000 }).trim()
    const [a, b] = JSON.parse(out)
    eq('extraTools 加了就放行 sound_read', a, true)
    eq('extraTools 没加的仍然拒 office_convert', b, false)
  } catch (err) {
    fail++
    console.log('FAIL 额外放行子进程跑不起来：' + String(err && err.message))
  }
}

// ── 3. 永久禁 ──────────────────────────────────────────────────────────
{
  for (const n of P.MOYU_BAN) eq('永久禁 ' + n, P.MOYU_BAN.has(n), true)
  eq('永久禁里必须有 plugin_manager', P.MOYU_BAN.has('plugin_manager'), true)
  eq('永久禁里必须有 workflow', P.MOYU_BAN.has('workflow'), true)
  eq('永久禁不该带上 write', P.MOYU_BAN.has('write'), false)
  eq('moyu_exit 不是永久禁（否则人被自己锁住）', P.MOYU_BAN.has('moyu_exit'), false)
}

// ── 4. 边界组合 ────────────────────────────────────────────────────────
{
  const st = stBase()
  let b = P.readBoundaries(st, cfgBase())
  eq('默认 跑=games', b.execName, 'games')
  eq('默认 联=开', b.net, true)
  eq('默认 社交=owner', b.social, 'owner')
  eq('默认 动=开', b.motion, true)

  st.boundaries = { net: false }
  b = P.readBoundaries(st, cfgBase())
  eq('关联 → 跑连带关', b.exec, false)
  eq('关联 → 社交连带 off', b.social, 'off')

  st.boundaries = { exec: 'off', net: true, social: 'off', motion: false }
  b = P.readBoundaries(st, cfgBase())
  eq('手动关跑', b.execName, 'off')
  eq('手动关社交', b.social, 'off')
  eq('手动关动', b.motion, false)

  st.boundaries = { exec: 'games' }
  b = P.readBoundaries(st, cfgBase())
  eq('state 指定 games 就用 games', b.execName, 'games')
  eq('games 盘子的 net 被 user:moyu 抹平', b.scope.net, false)
}

// ── 5. 读名单 ──────────────────────────────────────────────────────────
{
  const cfg = cfgBase()
  eq('读 qq-console.json 命中', !!P.readDeniedHit('C:\\Users\\Administrator\\.dsh\\qq-console.json', cfg), true)
  eq('读 storages/$.. 命中', !!P.readDeniedHit('C:\\Users\\Administrator\\.dsh\\storages\\workspace.json', cfg), true)
  eq('读 freetime 不命中', !!P.readDeniedHit('C:\\Users\\Administrator\\.dsh\\moyu\\freetime\\x.md', cfg), false)
  eq('读 DSH 别的目录不命中（只有名单里的才挡）', !!P.readDeniedHit('C:\\Users\\Administrator\\.dsh\\logs\\a.log', cfg), false)
}

// ── 6. 路径判定 ────────────────────────────────────────────────────────
{
  const tp = P.toolPaths({ path: 'a/b.txt' })[0]
  eq('toolPaths 转绝对路径', path.isAbsolute(tp) && /a[\\/]b\.txt$/.test(tp), true)
  const tp2 = P.toolPaths({ files: [{ path: 'x.md' }, { path: 'y.md' }] })
  eq('ops_read_files 取到两条', tp2.length, 2)
  eq('没有路径就空数组', P.toolPaths({}).length, 0)

  const roots = ['C:\\Users\\Administrator\\AkPlay\\', 'C:\\Users\\Administrator\\.dsh\\moyu\\freetime\\']
  eq('游乐场里算圈内', P.underRoot('C:\\Users\\Administrator\\AkPlay\\a.txt', roots), true)
  eq('freetime 里算圈内', P.underRoot('C:\\Users\\Administrator\\.dsh\\moyu\\freetime\\b.md', roots), true)
  eq('目录本身算圈内', P.underRoot('C:\\Users\\Administrator\\AkPlay', roots), true)
  eq('桌面不算', P.underRoot('C:\\Users\\Administrator\\Desktop\\x.txt', roots), false)
  eq('前缀冒充不算（AkPlay2）', P.underRoot('C:\\Users\\Administrator\\AkPlay2\\x.txt', roots), false)
  eq('往上层逃不算', P.underRoot('C:\\Users\\Administrator\\AkPlay\\..\\..\\x.txt', roots), false)
}

// ── 7. 严格档 ──────────────────────────────────────────────────────────
{
  const salt = 'deadbeefdeadbeef'
  const strict = { level: 1, passSalt: salt, passHash: P.hashPass('test-1234', salt) }
  eq('口令对', P.passOk(strict, 'test-1234'), true)
  eq('口令错', P.passOk(strict, 'test-12345'), false)
  eq('空口令', P.passOk(strict, ''), false)
  eq('没设口令时一律 false', P.passOk({ level: 0 }, 'whatever'), false)
  eq('strictOf 读到 level', P.strictOf({ strict }).level, 1)
  eq('strictOf 没配置时 level=0', P.strictOf({}).level, 0)
}

// ── 8. 顺序不变式（index.js 的 guard 必须按这个顺序判）──────────────────
{
  const src = fs.readFileSync(path.join(LIB, 'index.js'), 'utf8')
  const iBan = src.indexOf('MOYU_BAN.has(name)')
  const iAllow = src.indexOf('!allowedTool(name, cfg)')
  const iStamp = src.lastIndexOf('boundaryFingerprint(st.boundaries)')
  eq('顺序：永久禁在白名单之前', iBan > 0 && iBan < iAllow, true)
  eq('顺序：白名单在指纹比对之前', iAllow > 0 && iStamp > iAllow, true)
  eq('退出工具不在永久禁里', P.MOYU_BAN.has('moyu_exit'), false)
}

console.log('')
console.log(fail === 0 ? '全部通过' : `${fail} 条失败`)
process.exit(fail === 0 ? 0 : 1)

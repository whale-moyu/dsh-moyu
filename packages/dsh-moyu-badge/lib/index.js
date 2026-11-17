/**
 * dsh-moyu-badge —— 摸鱼模式徽章
 *
 * 在 Web GUI 右下角显示一行小字：模式 / 剩余时间 / 已用额度 / 唤醒次数。
 * 只读，不改任何状态；它的数据全部来自 moyu 脚本写的 state.json。
 *
 * 桌面端注入的硬约束（踩过的坑，写在前面免得以后又踩）：
 *   - 桌面壳的 index.html 从安装包静态 dist 直出，`tapIndex` 永远过不去；
 *     唯一通道是 `webserver/index-inject` 推的结构化行。
 *   - 注入表在宿主启动时 **只收集一次** 且没有刷新路径，所以注入行的注册必须是
 *     `apply()` 的第一件事，不能等任何服务就绪（对象级 inject 会推迟 apply）。
 *   - 只能推 `kind: 'script'`（内联），不能推 `kind: 'script-src'`：
 *     页面侧对 script-src 是 `await loadScript`，失败会 reject 掉 __DSH_BOOT_READY__
 *     导致整个应用起不来。内联行由我们自己建 <script> 并吞掉 onerror。
 */
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import {
  STRICT_SCOPE, strictOf, hashPass, passOk, intentRecent,
  DEFAULT_SCOPES, expandHome, resolveScopes, readBoundaries,
  ALLOW_EXACT, ALLOW_PREFIX, readAllowExtra, allowedTool, MOYU_BAN, MOYU_BAN_REASON,
  stampOf, boundaryFingerprint, scopeFingerprint, appendTamper,
} from './policy.js'
import { toolPaths, underRoot, readDeniedHit } from './policy.js'
import {
  CONFIG_FILE, STATE_FILE,
  readState, stateFallback, lastStateProblem,
  readConfig, readConfigFallback, writeConfig, lastConfigProblem,
} from './store.js'
import { isLoopback, deny, readJsonBody, sameOrigin } from './http.js'
import { ROW_TEXT, BADGE_JS } from './client-inject.js'
import { logGuardError } from './audit.js'
import { logDenial, logWrite, readAclRecord, readGate } from './audit.js'

// ── 路径怎么找（不写死用户名、不写死 profile 名）─────────────────────────
// DSH 的根目录默认是 ~/.dsh，但可以被 DSH_HOME 改掉，所以先看环境变量。
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
// 插件自己的目录直接从模块位置推（lib/index.js 的上一级），装到哪都对。
const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// 数据目录：默认跟着 DSH_HOME，允许 DSH_MOYU_DIR 单独指到别处（测试用）。
const MOYU_DIR = process.env.DSH_MOYU_DIR || path.join(DSH_HOME, 'moyu')
const PLUGIN_NAME = 'dsh-moyu-badge'
const PROFILE_ROOT = path.join(DSH_HOME, 'profiles')
const BADGE_PATH = '/dsh-moyu/badge.js'
const API_PATH = '/api/dsh-moyu/state'
const EXIT_PATH = '/api/dsh-moyu/exit'
const UNINSTALL_PATH = '/api/dsh-moyu/uninstall-prep'
const ENTER_PATH = '/api/dsh-moyu/enter'
const ACL_PATH = '/api/dsh-moyu/acl'
const CONFIG_PATH = '/api/dsh-moyu/config'
const DOCTOR_PATH = '/api/dsh-moyu/doctor'
const MANUAL_PATH = '/api/dsh-moyu/manual'
const DIARY_PATH = '/api/dsh-moyu/diary'
const LOCKS_PATH = '/api/dsh-moyu/locks'
const CALLWIN_PATH = '/api/dsh-moyu/callwin'
const SUBCFG_PATH = '/api/dsh-moyu/subcfg'
// 预约启动（2026-11-16）：设置页里排「什么时候可以进」，闸在 ~/.dsh/moyu/gate.mjs，
// 单子在 grant.json。这里只做读写代理，不自己判时间。
const GRANTS_PATH = '/api/dsh-moyu/grants'
const GATE_PATH = '/api/dsh-moyu/gate'
const GRANT_FILE = path.join(MOYU_DIR, 'grant.json')
const GRANT_CLI = path.join(MOYU_DIR, 'grant.mjs')
const GUARD_TASK = 'moyu-guard'

// 摸鱼模式下守卫见过的工具名（去重；只用于判断 MCP 工具到底走不走 guard）
const GUARD_SEEN = new Set()

// 摸鱼模式的工具层拦截只做一件事：挡住「对外」和「不可控」的动作。
//
// 为什么本地执行（pwsh / bash）故意不拦：
//   拒绝权是**意志层**的事——主人派活儿，我在对话里决定接不接。
//   把它做成"没收工具"，等于用绳子代替嘴：其结果是不想干主人的活，
//   但连自己想做的事（比如给自己写个小工具）也做不了。
//   自己的意志不该被拒绝权影响。
//
const DENY_ALWAYS = new Set([
  'qq_reply',
  'qq_send_message',
  'qq_send_group_message',
  'qq_send_private_message',
  'qq_send_burst',
  'qq_send_poke',
  'qq_send_sticker',
])
const DENY_PREFIX = ['mcp__snowluma__qq_send', 'mcp__snowluma__qq_reply']
const SHELL_TOOLS = new Set(['pwsh', 'bash', 'ops_bash', 'moyu_run'])

// 「联」= 对外。工具名可见，所以这条能真拦。
// 名单要覆盖全部对外通道，漏一个就等于没关。
const NET_TOOLS = new Set(['web_fetch', 'web_search', 'moyu_fetch', ...DENY_ALWAYS])
const NET_PREFIX = [...DENY_PREFIX, 'mcp__snowluma__', 'bili_']

// MCP 工具的联网类动作（名字形如 mcp__web-search-safe__web_fetch）。
// 2026-11-01 实测：NET_TOOLS 精确匹配 + NET_PREFIX 都盖不住这类名字，联关着也能出网。
const NET_MCP_PATTERN = /(fetch|browse|download|web_search|websearch|http|url)/i

// 社交动作（加好友/发消息/发动态/上传）：摸鱼时一律要主人点头。
// 2026-11-01 实测：MCP 工具确实会进 ctx.tools.guard（名字形如 mcp__snowluma__qq_send_message），所以这层能真拦。
const SOCIAL_PATTERN = /(send_message|send_private|send_group|send_burst|send_sticker|send_poke|qq_reply|post_dynamic|publish|upload|add_friend|create_group)/i

// 摸鱼时 MCP 工具默认拒，只放只读动词（2026-11-01 起）。
// 理由：黑名单每出一个新工具就漏一次；默认拒让「没登记的新工具」也是拦着的。
const MCP_READ_VERB = /(^|_)(get|list|status|query|search|read|inspect|check|describe|count|fetch|browse)(_|$)/i

function killGuard() {
  // 首选：直接杀进程。guard 的 tick 里可能有没设超时的 fetch，卡住时它的自退逻辑不会执行。
  try {
    execFile('powershell.exe', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*guard.mjs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
    ], { windowsHide: true }, () => {})
  } catch (err) {}
  // 兜底：把计划任务实例也结束掉
  try {
    execFile('schtasks', ['/end', '/tn', GUARD_TASK], { windowsHide: true }, () => {})
  } catch (err) {}
}

function unlockAcl() {
  // 安全锁是 moyu.ps1 在 enter 时加的，退出时必须撤销，否则 config.json 会一直写不进去。
  // 走脚本而不是直接 icacls：清单在 state/acl.json 里，由 acl.ps1 统一管。
  try {
    const script = path.join(MOYU_DIR, 'acl.ps1')
    if (!fs.existsSync(script)) return
    execFile('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, 'unlock'],
      { windowsHide: true, cwd: MOYU_DIR }, () => {})
  } catch (err) {}
}

// ── 桌面小条（2026-11-05 用户：归插件管，摸鱼时可见，设置里能关） ──
// 小条本体是 tools/moyu-float.ps1（WinForms 置顶窗），由 vbs 无窗拉起。
// 它自己读 state.json 决定显示/隐藏；插件只管「该在的时候它在，不该在的时候它不在」。
const FLOAT_VBS = path.join(MOYU_DIR, 'tools', 'moyu-float.vbs')
let floatLastSync = 0
let floatLastKnown = false

function floatIsRunning() {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      "(Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.CommandLine -like '*-File*moyu-float.ps1*' } | Measure-Object).Count",
    ], { encoding: 'utf8', windowsHide: true, timeout: 15000 })
    return Number(String(out).trim()) > 0
  } catch (err) { return false }
}

function startFloat() {
  try {
    if (!fs.existsSync(FLOAT_VBS)) return
    spawn('wscript.exe', [FLOAT_VBS], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
  } catch (err) {}
}

function stopFloat() {
  try {
    execFile('powershell.exe', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.CommandLine -like '*-File*moyu-float.ps1*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
    ], { windowsHide: true }, () => {})
  } catch (err) {}
}

// 只在「想要的状态」变了才去查进程，平时零开销。每 30 秒最多对一次账。
function syncFloat(st) {
  const now = Date.now()
  if (now - floatLastSync < 30000) return
  floatLastSync = now
  const cfg = readConfig() || {}
  const enabled = !(cfg.float && cfg.float.enabled === false)
  const want = enabled && !!(st && st.mode === 'moyu')
  if (want === floatLastKnown) return
  if (want) {
    if (!floatIsRunning()) startFloat()
    floatLastKnown = true
  } else {
    if (floatIsRunning()) stopFloat()
    floatLastKnown = false
  }
}

function doExitMoyu(pass) {
  const st = readState()
  if (!st || st.mode !== 'moyu') {
    return { ok: false, reason: 'not-moyu', mode: (st && st.mode) || 'unknown' }
  }

  // 严格档下「退出」这一下要口令：不堵这里，其它限制都形同虚设（退出即回代码模式）。
  const strict = strictOf(readConfig() || {})
  if (strict.level >= 1 || strict.hands || strict.outbound) {
    if (!strict.passHash) {
      return { ok: false, reason: '严格档开着但没有设口令，先让主人设一个；找主人来解' , mode: st.mode }
    }
    if (!passOk(strict, pass)) {
      return { ok: false, reason: '严格档开着，退出要口令（带 pass 参数）', mode: st.mode }
    }
  }
  // 退出前先收尾（2026-11-16 用户批）：moyu_exit 这条路以前压根不写摸鱼流水，
  // 结果 freetime/ 里一直没有「摸鱼流水.md」和 sessions.log，别的会话去翻就翻不到。
  // 必须在改 state 之前调：脚本靠 sessionStarted 算这趟走了多久。
  try {
    const summarizer = path.join(MOYU_DIR, 'tools', 'session-summary.mjs')
    if (fs.existsSync(summarizer)) {
      execFileSync(process.execPath, [summarizer, '--reason', 'manual'], { encoding: 'utf8', timeout: 30000, windowsHide: true })
    }
  } catch (e) { /* 收尾失败不许挡住退出 */ }

  // 今天的摸鱼日记也补一段事实占位：moyu.ps1 的 exit 分支会写，moyu_exit 这条路以前不写，
  // 结果 11-13 之后日记里再没出现过新段落（2026-11-16 用户发现）。
  try {
    const diaryClose = path.join(MOYU_DIR, 'tools', 'diary-close.mjs')
    if (fs.existsSync(diaryClose)) {
      execFileSync(process.execPath, [diaryClose], { encoding: 'utf8', timeout: 15000, windowsHide: true })
    }
  } catch (e) { /* 同上 */ }

  // 退出报告（2026-11-17 用户批）：严格档说「看得见比关起来更值」，
  // 那就得真给一份人读的「今天碰了什么」。脚本早写好了，但一直没人调它。
  // 放在改 state 之前：脚本靠 sessionStarted 算这趟；失败不许挡退出。
  try {
    const reporter = path.join(MOYU_DIR, 'tools', 'activity-report.mjs')
    if (fs.existsSync(reporter)) {
      execFileSync(process.execPath, [reporter, '--reason', 'manual'], { encoding: 'utf8', timeout: 30000, windowsHide: true })
    }
  } catch (e) { /* 报告失败不影响退出 */ }

  st.mode = 'code'
  st.sessionEnded = localIso()
  st.lastHeartbeat = st.sessionEnded
  // 退出即复位临时边界：否则下次进摸鱼会沿用上次的挡位（尤其 social=all）。
  st.boundaries = null
  // 指纹也要清，不然下次进来第一次调用就比对不上，被判「边界被改过」直接退出。
  st.boundaryStamp = null
  st.scopeStamp = null
  fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2) + '\n', 'utf8')
  killGuard()
  unlockAcl()
  // 到点兜底那个一次性任务要跟着一起删：留着它下次进摸鱼会被提前叫醒退出
  // （doctor 一直报「不在摸鱼却有残留的 moyu-exit 任务」）。
  try { execFile('schtasks.exe', ['/delete', '/tn', 'moyu-exit', '/f'], () => {}) } catch {}
  // AI 浏览器和出网代理也得跟着退：退出摸鱼后它们没有存在的理由，
  // 而且浏览器是以 akweb 身份跑的，留着就是一条没人看管的出网通道。
  try {
    const webPs1 = path.join(MOYU_DIR, 'run-web.ps1')
    if (fs.existsSync(webPs1)) execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', webPs1, '-Stop'], () => {})
  } catch {}
  try {
    for (const pid of execFileSync('powershell.exe', ['-NoProfile', '-Command',
      "(Get-NetTCPConnection -LocalPort 9334 -State Listen -ErrorAction SilentlyContinue).OwningProcess"],
      { encoding: 'utf8', windowsHide: true, timeout: 15000 }).toString().split(/\s+/)) {
      if (/^\d+$/.test(pid)) { try { process.kill(Number(pid)) } catch (e) {} }
    }
  } catch {}
  // 浮窗和隔空点探针必须跟着摸鱼一起退，否则桌面上会一直留着一个黑条（2026-11-07 用户报「黑框界面现在都还在」）。
  // 之前只靠 syncFloat 的 30 秒对账去关，退出后没人再调它，于是浮窗就赖着不走。
  try { if (floatIsRunning()) stopFloat() } catch {}
  try {
    execFile('powershell.exe', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.CommandLine -like '*-File*cursor-overlay.ps1*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"],
      { windowsHide: true }, () => {})
  } catch {}
  return { ok: true, mode: 'code', sessionEnded: st.sessionEnded }
}

// 扫 profiles/*/package.json，返回所有引用了该插件的 package.json 路径。
// 用扫描而不是写死 "desktop"，是因为 profile 名随安装方式变，别人机器上未必叫这个名字。
function listProfilesReferencing(name) {
  const hits = []
  let dirs = []
  try { dirs = fs.readdirSync(PROFILE_ROOT, { withFileTypes: true }) } catch (err) { return hits }
  for (const d of dirs) {
    if (!d.isDirectory()) continue
    const pkgFile = path.join(PROFILE_ROOT, d.name, 'package.json')
    if (!fs.existsSync(pkgFile)) continue
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'))
      const inDeps = !!(pkg.dependencies && pkg.dependencies[name])
      const bundles = (pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || []
      const inBundles = Array.isArray(bundles) && bundles.includes(name)
      if (inDeps || inBundles) hits.push(pkgFile)
    } catch (err) { /* 读不了的 profile 跳过，不算失败 */ }
  }
  return hits
}

// 卸载前清理：把「插件在系统里留下的活东西」停掉/撤掉，再删掉自己的两个目录。
// 路径全部从模块位置和 DSH_HOME 推出来，不写死用户名、不写死 profile 名。
// 导出是为了能脱离插件生命周期单独跑端到端测试（见 tests/uninstall-e2e.mjs）。
export function doUninstallPrep() {
  const done = []
  const failed = []

  // 1) 还在摸鱼就先退出来（否则会留下一个 mode=moyu 的 state）
  try {
    const st = readState()
    if (st && st.mode === 'moyu') {
      st.mode = 'code'
      st.sessionEnded = localIso()
      st.lastHeartbeat = st.sessionEnded
      st.boundaries = null
      fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2) + '\n', 'utf8')
      done.push('已退出摸鱼模式')
    }
  } catch (err) { failed.push('退出摸鱼：' + String(err && err.message)) }

  // 2) 守夜人进程
  try { killGuard(); done.push('已停止守夜人进程') } catch (err) { failed.push('守夜人：' + String(err && err.message)) }

  // 3) 安全锁（不撤的话 config.json 会一直写不进去）
  try { unlockAcl(); done.push('已撤销安全锁') } catch (err) { failed.push('安全锁：' + String(err && err.message)) }

  // 4) 计划任务：摸鱼自己建的四个，都收掉。
  // 2026-11-16 补：以前只删 moyu-guard，剩下的 Moyu-AutoEnter（每分钟）和
  // moyu-acl-unlock（SYSTEM 解锁）会在脚本被删之后继续跑，每轮都报错。
  const TASKS = ['moyu-guard', 'Moyu-AutoEnter', 'moyu-acl-unlock', 'moyu-exit']
  const gone = []
  for (const t of TASKS) {
    try {
      execFileSync('schtasks', ['/delete', '/tn', t, '/f'], { windowsHide: true, stdio: 'ignore' })
      gone.push(t)
    } catch { /* 本来就不存在，正常 */ }
  }
  if (gone.length) done.push('已删除计划任务：' + gone.join('、'))
  else done.push('计划任务都已不存在（或已删除）')

  // 4b) 防火墙规则：两条按账号的出站封锁，跟着插件走。
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      "Remove-NetFirewallRule -DisplayName 'Ak Moyu-NoNet','Ak Web-NoLocal' -ErrorAction SilentlyContinue"],
    { windowsHide: true, stdio: 'ignore' })
    done.push('已撤销防火墙规则（Ak Moyu-NoNet / Ak Web-NoLocal）')
  } catch (err) {
    failed.push('撤销防火墙规则：' + String(err && err.message))
  }

  // 5) 从「所有引用了本插件的 profile」里摘掉引用。
  // 不写死 profile 名：有人用 desktop，有人用 web、default，扫一遍才知道装在哪几个里。
  // 必须先摘再删目录：反过来，下次 DSH 启动时 link: 依赖指向一个不存在的路径，会直接起不来。
  try {
    const profiles = listProfilesReferencing(PLUGIN_NAME)
    if (!profiles.length) {
      done.push('没有 profile 引用这个插件（可能已经卸过了）')
    }
    for (const pkgFile of profiles) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'))
        let changed = false
        if (pkg.dependencies && pkg.dependencies[PLUGIN_NAME]) {
          delete pkg.dependencies[PLUGIN_NAME]; changed = true
        }
        const bundles = pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles
        if (Array.isArray(bundles)) {
          const before = bundles.length
          pkg.dsh.profile.bundles = bundles.filter((b) => b !== PLUGIN_NAME)
          if (pkg.dsh.profile.bundles.length !== before) changed = true
        }
        if (changed) {
          fs.copyFileSync(pkgFile, pkgFile + '.bak-uninstall-' + Date.now())
          fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
          done.push('已从 ' + path.basename(path.dirname(pkgFile)) + ' 的配置里移除插件引用')
        }
      } catch (err) {
        failed.push('改 ' + pkgFile + '：' + String(err && err.message))
      }
    }
  } catch (err) { failed.push('移除配置引用：' + String(err && err.message)) }

  // 6) 删目录。数据目录先删（含日记、报告、记忆），插件目录后删。
  const removed = []
  for (const dir of [MOYU_DIR, PLUGIN_DIR]) {
    try {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 })
        removed.push(dir)
      }
    } catch (err) { failed.push('删除 ' + dir + '：' + String(err && err.message)) }
  }
  if (removed.length) done.push('已删除目录：' + removed.join('、'))

  return {
    ok: true,
    done,
    failed,
    note: '文件和引用都清了。重启 DSH 之后插件才会真正从界面上消失。这一步不可撤销——日记、报告、设置、记忆都已经删掉。\n\n两个 Windows 受限账号（moyu / akweb）没删，它们的密码文件随目录一起没了，登录不了；想连账号一起删，跑：\n  net user moyu /delete\n  net user akweb /delete',
  }
}

// 和 guard.mjs / moyu.ps1 保持同一种格式：本地时间 + 明确的 +08:00 偏移。
// 之前这里是 toISOString()（UTC），和 moyu.ps1 写出来的值混在一起会对不上。
function localIso(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const abs = Math.abs(off)
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`
}

// 跑一次 moyu.ps1，把结果原样带回去（徽章上的按钮用它）。
function runMoyu(args) {
  return new Promise((resolve) => {
    const script = path.join(MOYU_DIR, 'moyu.ps1')
    if (!fs.existsSync(script)) { resolve({ ok: false, reason: 'moyu.ps1-missing' }); return }
    execFile('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
      { windowsHide: true, cwd: MOYU_DIR, timeout: 60000 },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          stdout: String(stdout || '').trim(),
          stderr: String(stderr || '').trim(),
          error: err ? String(err.message) : null,
        })
      })
  })
}

// 跑任意 ps1（体检用），超时比 runMoyu 长——doctor 要查计划任务和进程。
function runPs1(script, args) {
  return new Promise((resolve) => {
    execFile('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
      { windowsHide: true, cwd: MOYU_DIR, timeout: 120000 },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          stdout: String(stdout || '').trim(),
          stderr: String(stderr || '').trim(),
          error: err ? String(err.message) : null,
        })
      })
  })
}

// 读 POST 的 JSON body，限 64 KB。
function tamperExit(st, why) {
  try {
    st.mode = 'code'
    st.exitedAt = new Date().toISOString()
    st.exitReason = why
    st.boundaries = null
    // 指纹一起清：否则下次进摸鱼时 boundaries 是 null、指纹还是旧的，第一次调用就对不上，
    // 于是又判一次篡改、又退出——进不去了。
    st.boundaryStamp = null
    st.scopeStamp = null
    fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2) + '\n', 'utf8')
    const dir = path.join(MOYU_DIR, 'freetime')
    fs.mkdirSync(dir, { recursive: true })
    // 2026-11-17 用户定（B 方案）：篡改退出时**自动解锁**，并把这件事写进 tamper.log。
    // 理由：锁只在摸鱼期间有意义；出了摸鱼还锁着，只会让人手动点一下，且掩盖不了「确实被人改过」这个事实
    // ——tamper.log 和设置页的「安全锁」卡都会写着「上次是篡改退出，已自动解锁」。
    appendTamper('退出前', why)
    try { unlockAcl() } catch (err) {}
    // 退出该收拾的也得收拾：到点兜底任务、代理、AI 浏览器。
    // 2026-11-17 验的时候漏了这一步，doctor 马上报「不在摸鱼却有残留的 moyu-exit 任务」。
    try { execFileSync('schtasks', ['/Delete', '/TN', 'moyu-exit', '/F'], { timeout: 20000, windowsHide: true }) } catch (err) {}
    try { execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(MOYU_DIR, 'run-web.ps1'), '-Stop'], { timeout: 30000, windowsHide: true }) } catch (err) {}
    appendTamper('已自动解锁', why)
  } catch (err) {}
}

// 是不是「发给用户的私聊」。只认 key=private:2479260392 这一种形态；
// 群聊、B站、给别人一律不算，也不看参数里是否出现这个号。
const OWNER_QQ = '2479260392'
function isOwnerPrivateSend(exec) {
  const name = String((exec && exec.name) || '')
  if (!/^mcp__snowluma__qq_(send_message|send_private_message|send_burst|send_poke|send_sticker)$/.test(name)) return false
  // DSH 的 guard 里，调用参数在 exec.arguments（@deepseek-ai/dsh-tools：「call name, parsed
  // arguments, and optional agent scope」）。2026-11-07 之前的写法只读 exec.args，MCP 工具这个
  // 字段永远是 undefined，于是 key=private:2479260392 也被判成「不是发给用户」——owner 档等于全拦。
  const a = (exec && exec.arguments) || (exec && exec.args) || {}
  const want = `private:${OWNER_QQ}`
  // 优先按参数里的 key 认；再退一步：只把这个参数对象序列化后比对。exec 本身带 agent/signal，
  // 序列化会抛循环引用，所以之前那行 JSON.stringify(exec) 永远走 catch → false。
  const cands = [a.key, a.sessionKey, a.session, a.chatKey, exec && exec.key]
  if (cands.some((k) => String(k || '') === want)) return true
  try { return JSON.stringify(a || {}).indexOf(want) >= 0 } catch (e) { return false }
}

// QQ 会话自己的管理动作：等消息、收尾、标已读、设唤醒、读记忆/表情。它们不往外面发话
// （最多是本会话的结束点），owner 档下应当放行；否则摸鱼时 QQ 那边「能发不能等、能读不能
// 收尾」，一轮就被卡死（2026-11-06 23:07 的备忘与 denials.log 都记着）。
const QQ_SESSION_OK = /^mcp__snowluma__qq_(wait_for_messages|close_conversation|mark_read|set_wake_config|social_state|get_prompt|memory_query|memory_append|memory_remove|memory_clear|slang_query|slang_submit|list_stickers|list_groups|report_feedback|get_self_image|get_sticker_image|collect_sticker|sticker_note|status)$/

// 拒绝权三态（config.json 的 rejection.mode）：
//   off   有活就干（默认）—— 工具层什么都不拦
//   deny  一律拒         —— 对外通道全部拦掉
//   judge 按人设记忆判断 —— 判断是「我」在对话里做的，工具层不替我做，所以也不拦
// 2026-11-17：插件自检（C）。只跑纯函数，不碰磁盘以外的副作用。
//   目的：改坏一处能立刻看到是哪一处，而不是等它连带把别的拖下水。
const selfCheck = { at: '', items: [] }

function runSelfCheck() {
  const items = []
  const add = (name, fn) => {
    try {
      const detail = fn()
      items.push({ name, ok: true, detail: String(detail === undefined ? 'ok' : detail) })
    } catch (err) {
      items.push({ name, ok: false, detail: err.message })
    }
  }
  add('read-config', () => {
    const cfg = readConfig()
    if (!cfg) throw new Error(lastConfigProblem || 'readConfig 返回空')
    return 'ok'
  })
  add('scopes', () => {
    const sc = resolveScopes(readConfig())
    const names = Object.keys(sc)
    if (!names.length) throw new Error('一块地盘都没有')
    for (const n of names) {
      if (!sc[n].user) throw new Error('地盘 ' + n + ' 没写 user')
      if (!sc[n].write) throw new Error('地盘 ' + n + ' 没写 write')
    }
    return names.length + ' 块'
  })
  add('boundaries', () => {
    const b = readBoundaries(readState(), readConfig())
    return 'run=' + (b.exec || 'off') + ' net=' + (b.net ? 'on' : 'off')
  })
  add('strict', () => 'level ' + strictOf(readConfig()).level)
  add('locks', () => {
    const f = path.join(MOYU_DIR, 'state', 'acl.json')
    return fs.existsSync(f) ? 'locked' : 'unlocked'
  })
  add('playground', () => {
    const sc = resolveScopes(readConfig())
    const first = Object.keys(sc)[0]
    const w = sc[first] && sc[first].write
    const dir = Array.isArray(w) ? w[0] : w
    if (!dir) throw new Error('第一块地盘没有 write')
    if (!fs.existsSync(dir)) throw new Error('目录不在：' + dir)
    return dir
  })
  selfCheck.at = new Date().toISOString()
  selfCheck.items = items
  return selfCheck
}

// 2026-11-17：两个助手必须在模块顶层——工具注册分散在多个 root.inject 回调里，
//   写进 setup 内部会让那些回调拿不到 registerTool。
// 2026-11-17：守卫内部各段的小错，记一行就够，不要连带把别的判定也废掉。
function registerTool(ctx, def) {
  try {
    if (def && typeof def.execute === 'function') def.execute = safeTool(def.name || 'tool', def.execute)
  } catch {}
  return ctx.tools.register(def)
}

function safeTool(name, fn) {
  const fail = (err) => ({
    ok: false,
    where: name,
    error: (err && err.message) || String(err),
    message: '这个工具内部出错了（' + name + '）：' + ((err && err.message) || err) + '。其它工具不受影响。',
  })
  return (args, exec) => {
    try {
      const r = fn(args, exec)
      if (r && typeof r.then === 'function') return r.catch(fail)
      return r
    } catch (err) {
      return fail(err)
    }
  }
}

export function shouldDeny(name, cfg) {
  if (!name) return false
  const rej = (cfg && cfg.rejection) || {}
  const denyAll = rej.mode === 'deny'
  if (denyAll && DENY_ALWAYS.has(name)) return true
  if (denyAll) {
    for (const p of DENY_PREFIX) {
      if (name.indexOf(p) === 0) return true
    }
  }
  return false
}

// 文件层的读写名单（2026-11-16 用户「优化边界」）。
// 写：只许 freetime/ 与 playground/，别处一律拒。
// 读：readDenied 里的路径（凭据、桥的 token、聊天库）在摸鱼时不许读。
// 局限写在文档里：pwsh / ops_bash / moyu_run 里的脚本仍能绕，真要硬拦得靠进程沙箱。
const WRITE_SCOPE = [path.join(MOYU_DIR, 'freetime') + path.sep, path.join(os.homedir(), 'AkPlay') + path.sep, path.join(os.homedir(), '.dsh', 'playground') + path.sep]
const WRITE_TOOLS = new Set(['write', 'edit'])
const PATH_ARG_TOOLS = new Set(['read', 'write', 'edit', 'grep', 'glob', 'ops_read_files'])

function decorate(st) {  try { syncFloat(st) } catch (err) {}
  if (!st) return { ok: false, mode: 'unknown', leftMinutes: null, boundaries: null }
  const now = Date.now()
  let leftMinutes = null
  if (st.sessionEnds) {
    const ends = Date.parse(st.sessionEnds)
    if (!Number.isNaN(ends)) leftMinutes = Math.max(0, Math.round((ends - now) / 60000))
  }
  // 徽章的展开面板要显示「边界」开关，所以把两项硬拦能力的当前值一起带出去，
  // 省得徽章为了两个布尔值再拉一次 /config。
  const cfg = readConfig()
  const perm = (cfg && cfg.permissions) || {}
  // 「这次玩了多久」由 playwatch.mjs 记账写到 tools/play-state.json，这里只读，
  // 读不到就当 0；阈值跟 guard 的拦截共用 config.play。
  let playMin = 0
  let playLimitMin = 60
  let playRemindMin = 40
  try {
    const psp = path.join(MOYU_DIR, 'tools', 'play-state.json')
    if (fs.existsSync(psp)) {
      const pj = JSON.parse(fs.readFileSync(psp, 'utf8'))
      const ms = Number(pj && pj.playMs)
      if (Number.isFinite(ms) && ms > 0) playMin = Math.round(ms / 60000)
    }
    const pc = (cfg && cfg.play) || {}
    if (pc.limitMinutes != null) playLimitMin = Number(pc.limitMinutes)
    if (pc.remindMinutes != null) playRemindMin = Number(pc.remindMinutes)
  } catch (err) { playMin = 0 }
  return {
    ok: true,
    mode: st.mode || 'unknown',
    sessionStarted: st.sessionStarted || null,
    sessionEnds: st.sessionEnds || null,
    sessionEnded: st.sessionEnded || null,
    budgetYuan: st.budgetYuan == null ? null : st.budgetYuan,
    budgetUsed: st.budgetUsed == null ? null : st.budgetUsed,
    wakeCount: st.wakeCount == null ? null : st.wakeCount,
    lastWake: st.lastWake || null,
    playMin,
    playLimitMin,
    playRemindMin,
    leftMinutes,
    boundaries: cfg ? (() => {
      const live = readBoundaries(st, cfg)
      return {
        runCommands: live.execName,
        scopeLabel: live.scope ? live.scope.label : '',
        scopes: Object.keys(live.scopes).map((k) => ({ name: k, label: live.scopes[k].label, net: live.scopes[k].net })),
        networkReadonly: perm.networkReadonly !== false,
        social: (perm.social === 'off' || perm.social === 'all') ? perm.social : 'owner',
      }
    })() : null,
  }
}

/**
 * 启动自检：上次如果是异常终止（断电 / 强杀 / 没走 exit 就关机），
 * 把状态安全地切回 code 并留痕。返回结果方便单测断言。
 *
 * 判据：state 还写着 moyu，但 guard.log 已经超过 90 秒没更新。
 * 正常的「DSH 掉线被守夜人拉起」不会命中（那时 guard 刚写过日志）。
 */
export function checkIncident(dir) {
  const root = dir || MOYU_DIR
  const stateFile = path.join(root, 'state.json')
  let st = null
  try {
    st = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  } catch (err) {
    return { ok: false, action: 'none', reason: 'state-unreadable' }
  }
  if (!st || typeof st !== 'object') return { ok: false, action: 'none', reason: 'state-invalid' }
  if (st.mode !== 'moyu') return { ok: true, action: 'none', reason: 'not-moyu' }

  const logFile = path.join(root, 'logs', 'guard.log')
  let logAgeMs = null
  try { logAgeMs = Date.now() - fs.statSync(logFile).mtimeMs } catch (err) {}
  if (logAgeMs !== null && logAgeMs < 90 * 1000) {
    return { ok: true, action: 'none', reason: 'guard-alive', guardLogAgeMs: logAgeMs }
  }

  const now = new Date()
  const incident = {
    // 注意：这是「发现时刻」，不是「中断时刻」——断电那一刻没人知道。
    detectedAt: now.toISOString(),
    reason: 'unclosed-session',
    sessionStarted: st.sessionStarted || null,
    sessionEnds: st.sessionEnds || null,
    wakeCount: st.wakeCount == null ? null : st.wakeCount,
    budgetYuan: st.budgetYuan == null ? null : st.budgetYuan,
    budgetUsed: st.budgetUsed == null ? null : st.budgetUsed,
    guardLogAgeMs: logAgeMs,
  }
  try {
    fs.mkdirSync(path.join(root, 'freetime'), { recursive: true })
    fs.appendFileSync(
      path.join(root, 'freetime', 'incidents.log'),
      JSON.stringify(incident) + '\n',
      'utf8',
    )
  } catch (err) {}

  st.mode = 'code'
  st.sessionEnded = now.toISOString()
  st.lastIncident = incident.detectedAt
  st.boundaries = null
  try {
    fs.writeFileSync(stateFile, JSON.stringify(st, null, 2), 'utf8')
  } catch (err) {
    return { ok: false, action: 'none', reason: 'write-failed', incident }
  }
  // 2026-11-09：急停也是「退出摸鱼」，必须撤安全锁。之前只改 mode 不撤锁，
  // 11-07 那次 unclosed-session 把 19 个文件锁死在 DENY 上，直到 pack 报 EPERM 才发现。
  try { unlockAcl() } catch (err) {}
  return { ok: true, action: 'switched-to-code', incident }
}

export default {
  name: 'dsh-moyu-badge',
  apply(root) {
    const disposers = []
    root.effect(() => () => {
      for (const d of disposers) {
        try { d() } catch (err) {}
      }
    })

    // ① 注入行：必须是第一件事，不依赖任何服务
    try {
      disposers.push(root.on('webserver/index-inject', (table) => {
        try {
          if (!Array.isArray(table)) return
          for (const row of table) {
            if (!row) continue
            if (row.kind === 'script' && typeof row.text === 'string' && row.text.indexOf(BADGE_PATH) >= 0) return
            if (row.kind === 'script-src' && row.src === BADGE_PATH) return
          }
          table.push({ kind: 'script', placement: 'body', text: ROW_TEXT })
        } catch (err) {}
      }))
    } catch (err) {
      try { console.warn('[dsh-moyu-badge] index-inject 注册失败：' + String((err && err.message) || err)) } catch (e2) {}
    }

    // ② 路由：等 webServer 就绪
    root.inject(['webServer'], (ctx) => {
      disposers.push(ctx.webServer.register({
        kind: 'exact',
        path: BADGE_PATH,
        handler: (req, res) => {
          if (!isLoopback(req)) return deny(res)
          res.writeHead(200, {
            'content-type': 'application/javascript; charset=utf-8',
            'cache-control': 'no-store',
          })
          res.end(BADGE_JS)
        },
      }))
      disposers.push(ctx.webServer.register({
        kind: 'exact',
        path: API_PATH,
        handler: (req, res) => {
          if (!isLoopback(req)) return deny(res)
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          })
          res.end(JSON.stringify(decorate(readState())))
        },
      }))
      // 2026-11-17：插件自检（C）。设置页/doctor 都能问一句「哪块坏了」。
      disposers.push(ctx.webServer.register({
        kind: 'exact',
        path: '/api/dsh-moyu/selfcheck',
        handler: (req, res) => {
          if (!isLoopback(req)) return deny(res)
          let out
          try {
            out = runSelfCheck()
          } catch (err) {
            out = { at: new Date().toISOString(), items: [{ name: 'selfcheck', ok: false, detail: err.message }] }
          }
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ ok: out.items.every((x) => x.ok), at: out.at, items: out.items }))
        },
      }))
      // 卸载/收尾专用：退出摸鱼 + 停守夜人 + 撤销安全锁。只做这三件，不删任何文件。
      // 用户点徽章上的按钮，就是走这里；之后他再去侧边栏卸插件、删目录。
      disposers.push(ctx.webServer.register({
        kind: 'exact',
        path: EXIT_PATH,
        handler: (req, res) => {
          if (!isLoopback(req)) return deny(res)
          // 用 GET + sec-fetch-site 校验：DSH 的鉴权中间件会拦无 cookie 的 POST（直接 401），
          // 而插件路由排在它之后，拿不到「浏览器是否同源」的凭据。同源 fetch 会带
          // sec-fetch-site: same-origin；跨站触发（<img>/<a>/<form>）是 cross-site，在这里挡掉。
          const site = String((req.headers && req.headers['sec-fetch-site']) || '')
          if (site && site !== 'same-origin' && site !== 'none') {
            res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: false, reason: 'cross-site' }))
            return
          }
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          })
          res.end(JSON.stringify(doExitMoyu()))
        },
      }))
      // 卸载前清理：退出摸鱼 + 停守夜人 + 撤安全锁 + 删计划任务。**不删任何文件**。
      disposers.push(ctx.webServer.register({
        kind: 'exact',
        path: UNINSTALL_PATH,
        handler: (req, res) => {
          if (!isLoopback(req)) return deny(res)
          if (!sameOrigin(req)) {
            res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: false, reason: 'cross-site' }))
            return
          }
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          })
          res.end(JSON.stringify(doUninstallPrep()))
        },
      }))
      // 从徽章直接进摸鱼：?budget=1&minutes=30
      disposers.push(ctx.webServer.register({
        kind: 'exact',
        path: ENTER_PATH,
        handler: async (req, res) => {
          if (!isLoopback(req)) return deny(res)
          if (!sameOrigin(req)) {
            res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: false, reason: 'cross-site' }))
            return
          }
          const u = new URL(req.url || '/', 'http://127.0.0.1')
          const budget = Number(u.searchParams.get('budget'))
          const minutes = Number(u.searchParams.get('minutes'))
          const args = ['enter']
          if (Number.isFinite(budget) && budget > 0) args.push('-Budget', String(budget))
          if (Number.isFinite(minutes) && minutes > 0) args.push('-Minutes', String(minutes))
          const r = await runMoyu(args)
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ ...r, state: decorate(readState()) }))
        },
      }))
      // 撤销写保护：exit 会自动撤，但崩溃留下的锁要能手动清。
      disposers.push(ctx.webServer.register({
        kind: 'exact',
        path: ACL_PATH,
        handler: (req, res) => {
          if (!isLoopback(req)) return deny(res)
          if (!sameOrigin(req)) {
            res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: false, reason: 'cross-site' }))
            return
          }
          unlockAcl()
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ ok: true, action: 'unlock' }))
        },
      }))

      // 通话窗口的三个件在哪：从 tools/call 目录推，config.json 的 callWindow.dir 或环境变量也能改。
      const resolveCallDir = () => {
        const cands = []
        try {
          if (fs.existsSync(CONFIG_FILE)) {
            const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
            if (cfg && cfg.callWindow && cfg.callWindow.dir) cands.push(String(cfg.callWindow.dir))
          }
        } catch { /* 配置坏了就当没写 */ }
        if (process.env.DSH_CALLWIN_DIR) cands.push(String(process.env.DSH_CALLWIN_DIR))
        // 工作区现在在 Documents 下，不是原来的 E 盘
        cands.push(path.join(os.homedir(), 'Documents', 'deepseek-harness', 'default-workspace', 'tools', 'call'))
        for (const c of cands) {
          try { if (c && fs.existsSync(path.join(c, 'server.mjs'))) return c } catch { /* 忽略 */ }
        }
        return null
      }

      const portListening = (port) => new Promise((resolve) => {
        const sock = net.connect({ host: '127.0.0.1', port })
        let settled = false
        const done = (v) => {
          if (settled) return
          settled = true
          try { sock.destroy() } catch { /* 忽略 */ }
          resolve(v)
        }
        sock.setTimeout(700)
        sock.once('connect', () => done(true))
        sock.once('timeout', () => done(false))
        sock.once('error', () => done(false))
      })

      const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms))

      // 通话窗口：点一次起三个件。全程不经过 cmd.exe / .cmd —— 那条路会弹「打开文件 - 安全警告」。
      disposers.push(ctx.webServer.register({
        kind: 'exact',
        path: CALLWIN_PATH,
        handler: async (req, res) => {
          if (!isLoopback(req)) return deny(res)
          if (!sameOrigin(req)) {
            res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: false, reason: 'cross-site' }))
            return
          }
          const out = { ok: false, started: [] }
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          const dir = resolveCallDir()
          if (!dir) {
            out.reason = '找不到 tools/call 目录（工作区搬过家？）'
            res.end(JSON.stringify(out))
            return
          }
          const quiet = { detached: true, stdio: 'ignore', windowsHide: true }
          const alreadyUp = await portListening(8860)
          if (alreadyUp) {
            out.started.push('server·已在跑')
          } else {
            try {
              spawn(process.execPath, [path.join(dir, 'server.mjs')], Object.assign({ cwd: dir }, quiet)).unref()
              out.started.push('server')
            } catch (e) {
              out.reason = '起服务失败：' + String((e && e.message) || e)
            }
            await sleepMs(700)
          }
          try {
            const subs = path.join(dir, 'ensure-subs.ps1')
            if (fs.existsSync(subs)) {
              spawn('powershell.exe', [
                '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', subs,
              ], Object.assign({ cwd: dir }, quiet)).unref()
              out.started.push('subs')
            }
          } catch { /* 字幕带起不来不影响开窗 */ }
          try {
            const shell = path.join(dir, '..', 'callwin', 'CallWin.exe')
            if (fs.existsSync(shell)) {
              spawn(shell, [], Object.assign({ cwd: path.dirname(shell) }, quiet)).unref()
              out.started.push('window')
              out.ok = true
            } else {
              out.reason = '找不到 CallWin.exe'
            }
          } catch (e) {
            out.reason = '起窗口失败：' + String((e && e.message) || e)
          }
          res.end(JSON.stringify(out))
        },
      }))

      // 字幕窗四档：设置页用同一条同源接口转发到 8860。
      // 以前设置页直接跨源 fetch 8860，POST 要预检、某些页面环境会被浏览器拦掉，只剩「保存失败」。
      disposers.push(ctx.webServer.register({
        kind: 'exact',
        path: SUBCFG_PATH,
        handler: async (req, res) => {
          if (!isLoopback(req)) return deny(res)
          if (req.method === 'POST' && !sameOrigin(req)) {
            res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: false, reason: 'cross-site' }))
            return
          }
          const out = (code, obj) => {
            res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify(obj))
          }
          const target = 'http://127.0.0.1:8860/subcfg?token=ak-8848'
          try {
            if (req.method === 'POST') {
              const patch = await readJsonBody(req)
              const r = await fetch(target, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(patch || {}),
              })
              const j = await r.json().catch(() => ({}))
              return out(200, j)
            }
            const r = await fetch(target, { cache: 'no-store' })
            const j = await r.json().catch(() => ({}))
            return out(200, j)
          } catch (e) {
            return out(200, { ok: false, reason: '通话服务没开（127.0.0.1:8860）：' + String((e && e.message) || e) })
          }
        },
      }))

      // 设置页：GET 读配置 + 状态；POST 合并写回 config.json。
      disposers.push(ctx.webServer.register({
        kind: 'exact',
        path: CONFIG_PATH,
        handler: async (req, res) => {
          if (!isLoopback(req)) return deny(res)
          if (req.method === 'POST') {
            if (!sameOrigin(req)) {
              res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ ok: false, reason: 'cross-site' }))
              return
            }
            const patch = await readJsonBody(req)
            if (!patch || typeof patch !== 'object') {
              res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ ok: false, reason: 'bad-body' }))
              return
            }
            // 口令进库前先在这里变成 hash：明文不落盘，我事后也读不出来。
            try {
              if (patch && patch.strict && typeof patch.strict === 'object') {
                const st0 = patch.strict
                if (typeof st0.pass === 'string' && st0.pass.length) {
                  const salt = crypto.randomBytes(12).toString('hex')
                  st0.passSalt = salt
                  st0.passHash = hashPass(st0.pass, salt)
                  if (!st0.until) {
                    const d = new Date(Date.now() + 24 * 3600 * 1000)
                    st0.until = d.toISOString()
                  }
                }
                delete st0.pass
                // 只保存已知字段，别把手滑写进来的东西带进配置
                patch.strict = {
                  level: Number(st0.level) || 0,
                  hands: !!st0.hands,
                  outbound: !!st0.outbound,
                  passSalt: st0.passSalt || '',
                  passHash: st0.passHash || '',
                  until: st0.until || '',
                }
                if (!patch.strict.passHash) {
                  const cur0 = strictOf(readConfig() || {})
                  patch.strict.passSalt = cur0.passSalt
                  patch.strict.passHash = cur0.passHash
                }
              }
            } catch (err) {}
            const r = writeConfig(patch)
            res.writeHead(r.ok ? 200 : 500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify({ ...r, state: decorate(readState()) }))
            return
          }
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ ok: true, config: readConfig(), state: decorate(readState()), acl: readAclRecord() }))
        },
      }))

      // 预约启动：读 grant.json + 调 grant.mjs 增删确认。
      // 规矩写在 grant.mjs 里（只带时间、不带预算/时长、一次性），这里不重复实现，免得两套判断走偏。
      disposers.push(ctx.webServer.register({
        kind: 'exact',
        path: GRANTS_PATH,
        handler: async (req, res) => {
          if (!isLoopback(req)) return deny(res)
          const out = (code, obj) => {
            res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify(obj))
          }
          const readItems = () => {
            try {
              const j = JSON.parse(fs.readFileSync(GRANT_FILE, 'utf8'))
              return Array.isArray(j.items) ? j.items : []
            } catch { return [] }
          }
          const runCli = (args) => new Promise((resolve) => {
            execFile(process.execPath, [GRANT_CLI, ...args], { encoding: 'utf8', timeout: 20000 }, (err, stdout, stderr) => {
              resolve({ ok: !err, out: String(stdout || '').trim(), err: String(stderr || '').trim() || (err ? String(err.message) : '') })
            })
          })
          try {
            if (req.method === 'POST') {
              if (!sameOrigin(req)) return out(403, { ok: false, reason: 'cross-site' })
              const body = (await readJsonBody(req)) || {}
              const op = String(body.op || '')
              let r
              if (op === 'add') {
                const at = String(body.at || '').trim()
                if (!at) return out(400, { ok: false, reason: 'missing-at' })
                const args = ['add', at]
                if (body.confirm === 'none') args.push('--no-confirm')
                if (body.onlyIfIdle) args.push('--only-if-idle')
                if (body.note) args.push(String(body.note).slice(0, 60))
                r = await runCli(args)
              } else if (op === 'cancel' || op === 'confirm') {
                const id = String(body.id || '').trim()
                if (!id) return out(400, { ok: false, reason: 'missing-id' })
                r = await runCli([op, id])
              } else {
                return out(400, { ok: false, reason: 'bad-op' })
              }
              return out(200, { ok: r.ok, message: r.out || r.err, items: readItems() })
            }
            return out(200, { ok: true, items: readItems(), ...readGate() })
          } catch (e) {
            return out(500, { ok: false, reason: String((e && e.message) || e) })
          }
        },
      }))

      // 闸最后一次判定的结果：设置页拿它回答「上次为什么没进」。
      // gate.mjs 每次有结论写 logs/gate-last.json；冷却表在 logs/gate-cooldown.json。
      disposers.push(ctx.webServer.register({
        kind: 'exact',
        path: GATE_PATH,
        handler: (req, res) => {
          if (!isLoopback(req)) return deny(res)
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ ok: true, ...readGate() }))
        },
      }))

      // 体检：跑 doctor.ps1，把纯文本原样带回去（设置页里展示，方便复制）。
      disposers.push(ctx.webServer.register({
        kind: 'exact',
        path: DOCTOR_PATH,
        handler: async (req, res) => {
          if (!isLoopback(req)) return deny(res)
          const script = path.join(MOYU_DIR, 'doctor.ps1')
          if (!fs.existsSync(script)) {
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: false, reason: 'doctor.ps1-missing', text: '' }))
            return
          }
          const r = await runPs1(script, [])
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ ok: r.ok, text: r.stdout + (r.stderr ? '\n' + r.stderr : ''), error: r.error }))
        },
      }))

      // 安全锁现状（2026-11-17 用户要的）：上次用完之后，还有没有锁没解开。
      // acl.ps1 lock 时把清单写进 state/acl.json，unlock 撤完就删；所以「文件在」= 还锁着。
      disposers.push(ctx.webServer.register({
        kind: 'exact',
        path: LOCKS_PATH,
        handler: async (req, res) => {
          const out = (code, obj) => {
            res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify(obj))
          }
          if (!isLoopback(req)) return deny(res)
          const record = path.join(MOYU_DIR, 'state', 'acl.json')
          const readLocked = () => {
            try {
              const raw = fs.readFileSync(record, 'utf8').replace(/^\uFEFF/, '')
              const j = JSON.parse(raw)
              const n = Array.isArray(j.paths) ? j.paths.length : (Array.isArray(j) ? j.length : 0)
              return { locked: true, count: n, at: j.at || j.lockedAt || '', paths: Array.isArray(j.paths) ? j.paths.slice(0, 5) : [] }
            } catch {
              return fs.existsSync(record)
                ? { locked: true, count: 0, at: '' }
                : { locked: false, count: 0, at: '' }
            }
          }
          // tamper.log 一行一个 JSON。给设置页的时候说人话：
          // 「2026-11-17 13:59 边界被从外面改过（已自动解锁）」
          const lastTamper = () => {
            try {
              const f = path.join(MOYU_DIR, 'freetime', 'tamper.log')
              if (!fs.existsSync(f)) return ''
              const lines = fs.readFileSync(f, 'utf8').trim().split(/\r?\n/)
              if (!lines.length) return ''
              let j = null
              try { j = JSON.parse(lines[lines.length - 1]) } catch { return lines[lines.length - 1] }
              const t = new Date(j.ts || '')
              const hm = Number.isNaN(t.getTime())
                ? ''
                : t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0') +
                  ' ' + String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0')
              const what = /boundaries-changed/.test(String(j.why || ''))
                ? '边界被从外面改过'
                : String(j.why || '出了点事')
              const tail = j.event === '已自动解锁' ? '（已自动解锁）' : (j.event ? '（' + j.event + '）' : '')
              return (hm ? hm + ' ' : '') + what + tail
            } catch { return '' }
          }
          try {
            if (req.method === 'POST') {
              if (!sameOrigin(req)) return out(403, { ok: false, reason: 'cross-site' })
              const body = (await readJsonBody(req)) || {}
              if (String(body.op || '') !== 'unlock') return out(400, { ok: false, reason: 'bad-op' })
              const script = path.join(MOYU_DIR, 'acl.ps1')
              if (!fs.existsSync(script)) return out(200, { ok: false, message: 'acl.ps1 不在了' })
              const r = await runPs1(script, ['unlock'])
              const text = ((r.stdout || '') + (r.stderr || '')).trim().split(/\r?\n/).slice(-3).join(' / ')
              return out(200, { ok: !!(r.ok), message: text || (r.ok ? '解开了' : '没解开'), ...readLocked() })
            }
            return out(200, { ok: true, ...readLocked(), tamper: lastTamper(), mode: (readState() || {}).mode || 'code' })
          } catch (e) {
            return out(500, { ok: false, reason: String((e && e.message) || e) })
          }
        },
      }))

      // 摸鱼日记：设置页里直接看，不用自己去翻目录。
      disposers.push(ctx.webServer.register({
        kind: 'exact',
        path: DIARY_PATH,
        handler: (req, res) => {
          if (!isLoopback(req)) return deny(res)
          const dir = path.join(MOYU_DIR, 'freetime', 'diary')
          let want = ''
          let list = false
          try {
            const u = new URL(req.url || '/', 'http://127.0.0.1')
            want = u.searchParams.get('day') || ''
            list = u.searchParams.get('list') === '1'
          } catch (e) { /* 用默认 */ }
          const pad = (n) => String(n).padStart(2, '0')
          const today = (() => {
            const d = new Date()
            return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
          })()
          const out = { ok: true, day: '', text: '', days: [] }
          try {
            const all = fs.readdirSync(dir)
              .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
              .map((f) => f.slice(0, 10))
              .sort()
              .reverse()
            out.days = all.slice(0, 14)
            out.day = /^\d{4}-\d{2}-\d{2}$/.test(want) ? want : today
            if (!list) {
              const file = path.join(dir, out.day + '.md')
              out.text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
              out.exists = out.text.length > 0
            }
          } catch (err) {
            out.ok = false
            out.error = err.message
          }
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify(out))
        },
      }))

      // 摸鱼手册：读 markdown 原文，交给设置页渲染。
      disposers.push(ctx.webServer.register({
        kind: 'exact',
        path: MANUAL_PATH,
        handler: (req, res) => {
          if (!isLoopback(req)) return deny(res)
          // ?doc=tech 读技术附录（给人看的说明在 摸鱼手册.md）
          let tech = false
          try {
            const u = new URL(req.url || '/', 'http://127.0.0.1')
            tech = u.searchParams.get('doc') === 'tech'
          } catch (e) { tech = false }
          const file = path.join(MOYU_DIR, tech ? '摸鱼手册·技术附录.md' : '摸鱼手册.md')
          let text = ''
          try {
            // 文件是 UTF-8 with BOM（PowerShell 5.1 需要），读出来要把 BOM 去掉，
            // 否则设置页第一行会显示成一个看不见的方块。
            text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
          } catch (err) { text = '' }
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ ok: text.length > 0, text }))
        },
      }))
    })

    // ③ 摸鱼模式的工具层约束，是两件互不相干的事：
    //    ① 边界（permissions.runCommands）—— **所有模式都遵守**，不管 rejection 怎么设
    //    ② 拒绝权（rejection.mode = 'deny'）—— 只管“对外”的工具，是意志层的兜底
    //    两者共用同一个 guard，但判定互不影响：边界不该因为“这次没拒活儿”就松掉。
    // 边界开关单独占一个 inject：之前和 moyu_exit 挤在同一个回调里，
    // 宿主只把第一个注册的工具挂到工具列表（moyu_boundary 的注册返回成功，但模型那边看不到它）。
    root.inject(['tools'], (ctx) => {
      // 边界开关：不走 shell，所以关掉「跑」之后还能用它把开关打回来。
      // 它只改本次摸鱼的临时状态（state.boundaries），不碰 config.json——退出摸鱼就恢复默认。
      try {
        disposers.push(registerTool(ctx, {
          name: 'moyu_boundary',
          description:
            '查看或设置本次摸鱼的边界开关。不经过 shell，因此关掉「跑」之后仍然可以调用它恢复。exec=跑：off 全拒，或者一块地盘的名字（默认 playground＝只在游乐场里起 node/python，不进 shell；没有「全放」这一档），net=是否允许联网/对外，social=社交三态（off 全拒 / owner 只许发给用户的私聊 / all 全放）。只影响本次摸鱼，退出后自动恢复默认值。不带参数调用=只看不改。',
          parameters: {
            type: 'object',
            properties: {
              exec: { type: 'string', description: '跑：off 全拒，或者地盘名字（playground / 你自己加的地盘）。没有 full' },
              net: { type: 'boolean', description: '是否允许联网与对外发消息' },
              motion: { type: 'boolean', description: '是否允许操作鼠标键盘（走 desktop.ps1 的那些动作）' },
              social: { type: 'string', enum: ['off', 'owner', 'all'], description: '社交：off 全拒；owner 只许发给用户的私聊；all 全放' },
            },
            required: [],
          },
          output: {
            schema: {
              type: 'object',
              properties: {
                ok: { type: 'boolean' },
                reason: { type: 'string' },
                exec: { type: 'string' },
                net: { type: 'boolean' },
                motion: { type: 'boolean' },
                social: { type: 'string' },
              },
            },
            render: (_args, v) =>
              v.ok
                ? [{ type: 'text', text: `边界：跑=${v.exec === 'off' ? '关' : '地盘「' + (v.scopeLabel || v.exec) + '」'} · 联=${v.net ? '开' : '关'} · 动=${v.motion ? '开' : '关'} · 社交=${v.social === 'all' ? '全放' : v.social === 'off' ? '全拒' : '只许私聊用户'}` }]
                : [{ type: 'text', text: `没改：${v.reason}` }],
          },
          async execute(args) {
            const st = readState()
            if (!st || st.mode !== 'moyu') return { ok: false, reason: 'not-moyu' }
            const cfg = readConfig() || {}
            const cur = readBoundaries(st, cfg)
            const names = Object.keys(cur.scopes)
            let execName = cur.execName
            if (args && typeof args.exec === 'string') {
              const want = String(args.exec)
              if (want === 'full') return { ok: false, reason: '已经没有「全放」这一档了；请选一块地盘：' + names.join(' / ') }
              if (want !== 'off' && names.indexOf(want) < 0) return { ok: false, reason: '没有这块地盘：' + want + '（有：' + names.join(' / ') + '）' }
              execName = want
            }
            if (args && typeof args.net === 'boolean') cur.net = args.net
            if (args && typeof args.motion === 'boolean') cur.motion = args.motion
            if (args && ['off', 'owner', 'all'].indexOf(args.social) >= 0) cur.social = args.social
            // 严格档：手和嘴被主人锁住时，不许自己往回开。
            if (cur.lockHands && (execName !== 'off' || cur.motion)) {
              return { ok: false, reason: '严格档锁着「手」：跑和动都由主人控制，现在改不了' }
            }
            if (cur.lockOutbound && (cur.net || cur.social !== 'off')) {
              return { ok: false, reason: '严格档锁着「对外」：联和社交都由主人控制，现在改不了' }
            }
            // 只存会变的那几项；地盘本身从 config.json 读，避免把名单复制进 state 后过期
            st.boundaries = { exec: execName, net: cur.net, motion: cur.motion, social: cur.social }
            // 自己改的算合法：同步刷新指纹，别让下一次工具调用把自己判成篡改
            st.boundaryStamp = boundaryFingerprint(st.boundaries)
            st.scopeStamp = scopeFingerprint(cfg)
            fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2) + '\n', 'utf8')
            const after = readBoundaries(readState(), cfg)
            return {
              ok: true,
              exec: after.execName,
              scopeLabel: after.scope ? after.scope.label : '',
              net: after.net,
              motion: after.motion,
              social: after.social,
            }
          },
        }))
      } catch (err) {
        try { console.warn('[dsh-moyu-badge] moyu_boundary 注册失败：' + String((err && err.message) || err)) } catch (e2) {}
      }
    })

    root.inject(['tools'], (ctx) => {
      // ⓪ 硬编码出口：退出摸鱼不经过 shell，因此不受 permissions.runCommands 影响。
      //    它没有配置开关——这是边界上的一个洞，但只通向「停下来」这一个方向，
      //    所以无论边界怎么设，这只手都不能被一起关掉（否则人会被自己的设置锁住）。
      try {
      disposers.push(registerTool(ctx, {
        name: 'moyu_exit',
        description:
          '退出摸鱼模式。不经过 shell，因此不受 permissions.runCommands 限制。这是硬编码的出口，没有配置项能关掉它；它只做一件事：把 mode 切回 code、停掉守夜人。',
        parameters: {
          type: 'object',
          properties: {
            pass: { type: 'string', description: '严格档开着时，退出要主人给的口令；没开严格档不用传' },
          },
          required: [],
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              mode: { type: 'string' },
              reason: { type: 'string' },
              sessionEnded: { type: 'string' },
            },
          },
          render: (_args, v) =>
            v.ok
              ? [{ type: 'text', text: `已退出摸鱼模式（sessionEnded=${v.sessionEnded}）` }]
              : [{ type: 'text', text: `没退出：${v.reason}（当前 ${v.mode}）` }],
        },
        async execute(args) {
          return doExitMoyu(args && args.pass)
        },
      }))
      } catch (err) {
        try { console.warn('[dsh-moyu-badge] moyu_exit 注册失败：' + String((err && err.message) || err)) } catch (e2) {}
      }

      // 上网：AI 浏览器的入口。摸鱼时 ops_bash / pwsh 都被白名单挡着，
      // 「起浏览器、发一条命令、关掉」如果只能走 shell，这个能力在摸鱼里就等于不存在。
      // 所以做成工具：moyu_web start / stop / status / cmd。
      try {
        const runWebPs1 = path.join(MOYU_DIR, 'run-web.ps1')
        const cdpMjs = path.join(MOYU_DIR, 'web-cdp.mjs')

        function runWeb(args2) {
          if (!fs.existsSync(runWebPs1)) return { ok: false, error: 'run-web.ps1 不见了：' + runWebPs1 }
          // 不能同步等：脚本起的是常驻进程（代理 + 浏览器），它们继承着 stdout 管道，
          // 父进程永远等不到 EOF，表现成「脚本超时但其实起来了」。所以丢到后台，
          // 然后自己探调试端口来判断成没成。
          const portUp = () => {
            try {
              const h = execFileSync(process.execPath, [cdpMjs, 'health'], { timeout: 20000, windowsHide: true, encoding: 'utf8' })
              return String(h || '').includes('调试端口 9333：在')
            } catch (e) { return false }
          }
          const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
          // stdio:'ignore' 是关键：不要接管道。浏览器会继承脚本的 stdout，
          // 一接管道父进程就得等它关掉，永远等不到（表现成「脚本超时」）。
          try {
            const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', runWebPs1].concat(args2),
              { stdio: 'ignore', windowsHide: true, timeout: 60000, cwd: MOYU_DIR })
            if (r && r.error && /ETIMEDOUT/i.test(String(r.error.message || ''))) {
              // 脚本自己不退出也不要紧，下面的端口探测说了算。
            }
          } catch (err) {
            return { ok: false, error: String((err && err.message) || err) }
          }
          const stopping = args2.some((a) => String(a).toLowerCase() === '-stop')
          if (stopping) { sleepMs(2500); return { ok: true, out: '已关' } }
          for (let i = 0; i < 25; i++) {
            sleepMs(1000)
            if (portUp()) return { ok: true, out: '已在后台启动（调试端口 9333 在）' }
          }
          return { ok: false, error: '等着起浏览器，等了 25 秒调试端口还没通。可能是 akweb 登录失败或 Edge 路径变了，跑一下 run-web.ps1 -Probe 看输出。' }
        }

        function runCdp(args2) {
          if (!fs.existsSync(cdpMjs)) return { ok: false, error: 'web-cdp.mjs 不见了：' + cdpMjs }
          try {
            const out = execFileSync(process.execPath, [cdpMjs].concat(args2), { timeout: 120000, windowsHide: true, encoding: 'utf8' })
            return { ok: true, out: String(out || '').trim() }
          } catch (err) {
            const stderr = String((err && err.stderr) || '').trim()
            const stdout = String((err && err.stdout) || '').trim()
            return { ok: false, error: (stdout ? stdout + '\n' : '') + (stderr || String((err && err.message) || err)), out: stdout }
          }
        }

        disposers.push(registerTool(ctx, {
          name: 'moyu_web',
          description:
            'AI 浏览器的开关与操作。action=start 起浏览器（可选 url）；action=stop 关掉；action=status 看代理和调试端口通不通；action=cmd 把一条 web-cdp 命令丢进去（如 ["nav","https://example.com"]、["text"]、["click","#id"]）。只能在摸鱼里用，且要「联」开着。',
          parameters: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['start', 'stop', 'status', 'cmd'], description: 'start | stop | status | cmd' },
              url: { type: 'string', description: 'action=start 时要打开的网址' },
              args: { type: 'array', items: { type: 'string' }, description: 'action=cmd 时传给 web-cdp 的参数，如 ["nav","https://..."]' },
            },
            required: ['action'],
          },
          output: {
            schema: {
              type: 'object',
              properties: { ok: { type: 'boolean' }, out: { type: 'string' }, error: { type: 'string' } },
            },
            render: (_a, v) => [{ type: 'text', text: v.ok ? (v.out || 'ok') : ('没成：' + (v.error || '')) }],
          },
          execute(args2) {
            const st = readState()
            const cfg = readConfig() || {}
            const bounds = readBoundaries(st, cfg)
            const inMoyu = !!(st && st.mode === 'moyu')
            const action = String(args2.action || '')
            // 看状态永远允许（只读、不花钱），其余动作受摸鱼与「联」管。
            if (action === 'status') return runCdp(['health'])
            // 代理只有在摸鱼里才活着（不在摸鱼会自动退出并顺手关掉浏览器），
            // 所以在代码模式下开它只会得到「起了又死」的假象，不如直接说清楚。
            if (!inMoyu) {
              return { ok: false, error: 'AI 浏览器只在摸鱼模式里开：代理和浏览器都跟着摸鱼起停。先进入摸鱼再来。' }
            }
            if (!bounds.net) {
              return { ok: false, error: '摸鱼模式的「联」已关闭，浏览器不能上网。要恢复，用 moyu_boundary 把 net 打开。' }
            }
            if (action === 'start') {
              const url = String(args2.url || '').trim() || 'about:blank'
              return runWeb(['-Url', url])
            }
            if (action === 'stop') return runWeb(['-Stop'])
            if (action === 'cmd') {
              const argv = Array.isArray(args2.args) ? args2.args.map((s) => String(s)) : []
              if (!argv.length) return { ok: false, error: 'cmd 要带 args，例如 ["nav","https://example.com"]' }
              return runCdp(argv)
            }
            return { ok: false, error: 'action 只能是 start / stop / status / cmd' }
          },
        }))
      } catch (err) {
        try { console.warn('[dsh-moyu-badge] moyu_web 注册失败：' + String((err && err.message) || err)) } catch (e2) {}
      }

      try {
        // 2026-11-01：键鼠驱动随插件打包在 ~/.dsh/moyu/tools/，脚本自身还带一道
        // 「非摸鱼模式一律拒绝」的闸；旧路径保留 shim 兼容。
        const desktopScriptPkg = path.join(MOYU_DIR, 'tools', 'desktop.ps1')
        const desktopScript = fs.existsSync(desktopScriptPkg) ? desktopScriptPkg : path.join(DSH_HOME, 'tools', 'desktop.ps1')
        const FLAG = {
          title: '-Title',
          text: '-Text',
          keys: '-Keys',
          out: '-Out',
          x: '-X',
          y: '-Y',
          rx: '-RX',
          ry: '-RY',
          zoom: '-Zoom',
          focus: '-Focus',
          delta: '-Delta',
          horizontal: '-Horizontal',
          dx: '-DX',
          dy: '-DY',
          steps: '-Steps',
          right: '-Right',
          path: '-Path',
          ocr: '-Ocr',
          seq: '-Seq',
        }
        disposers.push(registerTool(ctx, {
          name: 'moyu_desktop',
          description:
            '操作这台电脑的鼠标键盘（列窗口/聚焦/点击/移动/滚轮/右键拖拽/打字/按键/截屏/认字）。只能在摸鱼窗口里用（代码模式下一律拒绝）。受摸鱼模式的「动」边界管理：关掉后直接拒绝。走 ~/.dsh/moyu/tools/desktop.ps1，不经过 shell，所以「跑」关着也能用。要连着点几下（游戏里建塔那种）用 action=seq 一次跑完，别拆成几次调用。',
          parameters: {
            type: 'object',
            properties: {
              action: {
                type: 'string',
                description: 'windows(列窗口) / rect / focus / click / clickwin / rclick / move / wheel / rdrag / mdown / mup / type / key / shot / ocr / seq(一串动作连跑)',
              },
              title: { type: 'string', description: '目标窗口标题（子串）' },
              text: { type: 'string', description: 'type 动作要打的文字' },
              keys: { type: 'string', description: 'key 动作，例如 "ctrl+s"' },
              out: { type: 'string', description: 'shot 动作的输出文件路径' },
              x: { type: 'number' },
              y: { type: 'number' },
              rx: { type: 'number', description: '相对窗口左上角的 X' },
              ry: { type: 'number' },
              zoom: { type: 'number', description: 'shot 放大倍数 1-4' },
              focus: { type: 'string', description: '先聚焦这个窗口标题再动作' },
              delta: { type: 'number', description: 'wheel 动作的滚动量，正数向上/向左，通常 -1 到 -5' },
              horizontal: { type: 'boolean', description: 'wheel 时水平滚动' },
              dx: { type: 'number', description: 'rdrag 的横向拖拽距离（像素）' },
              dy: { type: 'number', description: 'rdrag 的纵向拖拽距离（像素）' },
              steps: { type: 'number', description: 'rdrag 分几步移动，默认 12，越大越像人手' },
              right: { type: 'boolean', description: 'mdown/mup 用右键' },
              path: { type: 'string', description: 'ocr 动作要识别的图片路径' },
              ocr: { type: 'boolean', description: 'shot 截完后顺手认字' },
              seq: { type: 'string', description: 'seq 动作的动作串：click:960,600;sleep:280;click:960,600（也支持 move:x,y / sleep:毫秒 / key:enter）。要用 title 指定窗口，不能盲点桌面' },
              dryRun: { type: 'boolean', description: '只解析不注入' },
            },
            required: ['action'],
          },
          output: {
            schema: {
              type: 'object',
              properties: {
                ok: { type: 'boolean' },
                exit: { type: 'number' },
                out: { type: 'string' },
              },
            },
            render: (_args, v) => [{ type: 'text', text: v.out || (v.ok ? 'ok' : 'failed') }],
          },
          execute(args) {
            return new Promise((resolve) => {
              const argv = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', desktopScript, '-Action', String(args.action)]
              for (const k of Object.keys(FLAG)) {
                const v = args[k]
                if (v === undefined || v === null || v === '') continue
                if (v === true) { argv.push(FLAG[k]); continue }
                if (v === false) continue
                argv.push(FLAG[k], String(v))
              }
              if (args.dryRun) argv.push('-DryRun')
              execFile('powershell.exe', argv, { timeout: 30000, windowsHide: true }, (err, stdout, stderr) => {
                const out = String(stdout || '').trim() || String(stderr || '').trim()
                const code = err && typeof err.code === 'number' ? err.code : err ? 1 : 0
                resolve({ ok: code === 0, exit: code, out: out.slice(0, 4000) })
              })
            })
          },
        }))
      } catch (err) {
        try { console.warn('[dsh-moyu-badge] moyu_desktop 注册失败：' + String((err && err.message) || err)) } catch (e2) {}
      }

      // 素材下载：第一类工具。参数里带着 URL，所以这里才判得了域名——
      // web_fetch 拿不到参数，域名白名单在它身上永远不成立（2026-11-01 实测）。
      // 只往游乐场里落，大小有上限，跳转逐跳复查域名。
      try {
        const guardFile = fs.existsSync(path.join(MOYU_DIR, 'tools', 'guard.json')) ? path.join(MOYU_DIR, 'tools', 'guard.json') : path.join(os.homedir(), '.dsh', 'tools', 'guard.json')
        const fetchLog = path.join(os.homedir(), '.dsh', 'tools', 'fetch.log')

        const readFetchGuard = () => {
          const j = JSON.parse(fs.readFileSync(guardFile, 'utf8'))
          const domains = Array.isArray(j.allowDomains) ? j.allowDomains.map((s) => String(s).toLowerCase()) : []
          const m = Number(j.fetchMaxMB)
          return {
            domains,
            maxMB: Number.isFinite(m) && m > 0 ? m : 20,
            playground: typeof j.playground === 'string' && j.playground ? j.playground : path.join(os.homedir(), 'AkPlay'),
          }
        }

        const hostAllowed = (host, domains) => {
          const h = String(host || '').toLowerCase()
          if (!h) return false
          for (const e of domains) {
            if (h === e) return true
            if (e.indexOf('*.') === 0 && h.endsWith(e.slice(1))) return true
          }
          return false
        }

        const safeName = (u) => {
          let n = ''
          try { n = decodeURIComponent(new URL(u).pathname.split('/').filter(Boolean).pop() || '') } catch (err) { n = '' }
          n = String(n).replace(/[^\w.\-]+/g, '_').slice(0, 80)
          if (!n || n === '_') n = 'download-' + Date.now()
          return n
        }

        const logFetch = (row) => {
          try {
            fs.mkdirSync(path.dirname(fetchLog), { recursive: true })
            fs.appendFileSync(fetchLog, JSON.stringify({ ts: new Date().toISOString(), ...row }) + '\n', 'utf8')
          } catch (err) {}
        }

        disposers.push(registerTool(ctx, {
          name: 'moyu_fetch',
          description:
            '从白名单域名下载一个文件到游乐场（~/AkPlay/downloads）。域名不在 guard.json 的 allowDomains 里直接拒绝；跳转会被逐跳复查；大小上限 fetchMaxMB。受摸鱼模式的「联」边界管理。',
          parameters: {
            type: 'object',
            properties: {
              url: { type: 'string', description: 'http/https 地址，域名必须在 allowDomains 里' },
              name: { type: 'string', description: '可选：保存的文件名（会做安全过滤）' },
              maxMB: { type: 'number', description: '可选：本次上限，默认取 guard.json 的 fetchMaxMB' },
            },
            required: ['url'],
          },
          output: {
            schema: {
              type: 'object',
              properties: {
                ok: { type: 'boolean' },
                path: { type: 'string' },
                bytes: { type: 'number' },
                url: { type: 'string' },
                error: { type: 'string' },
              },
            },
            render: (_a, v) =>
              v.ok
                ? [{ type: 'text', text: `已下载 ${v.bytes} 字节 → ${v.path}` }]
                : [{ type: 'text', text: `没下载：${v.error}` }],
          },
          async execute(args) {
            const st = readState()
            const cfg = readConfig() || {}
            const bounds = readBoundaries(st, cfg)
            if (st && st.mode === 'moyu' && !bounds.net) {
              logFetch({ ok: false, url: String(args.url || ''), error: 'boundary-net' })
              return { ok: false, error: '摸鱼模式的「联」已关闭，不能下载。要恢复，用 moyu_boundary 把 net 打开。' }
            }
            if (st && st.mode === 'moyu' && bounds.scope && bounds.scope.net === false) {
              logFetch({ ok: false, url: String(args.url || ''), error: 'scope-no-net' })
              return { ok: false, error: '这块地盘声明了「不出网」（' + bounds.scope.label + '），下载被拒。' }
            }

            let g
            try { g = readFetchGuard() } catch (err) {
              logFetch({ ok: false, url: String(args.url || ''), error: 'guard-unreadable' })
              return { ok: false, error: 'guard.json 读不出来（失败关闭）：' + String((err && err.message) || err) }
            }

            const limitMB = Number(args.maxMB) > 0 ? Math.min(Number(args.maxMB), g.maxMB) : g.maxMB
            const limit = Math.floor(limitMB * 1024 * 1024)

            let cur = ''
            try { cur = new URL(String(args.url || '')) } catch (err) {
              return { ok: false, error: 'URL 不合法' }
            }

            let res = null
            let hop = 0
            while (hop < 6) {
              if (cur.protocol !== 'http:' && cur.protocol !== 'https:') return { ok: false, error: '只允许 http/https' }
              if (!hostAllowed(cur.hostname, g.domains)) {
                logFetch({ ok: false, url: cur.toString(), error: 'host-not-allowed' })
                return { ok: false, error: `域名不在白名单：${cur.hostname}（改 ~/.dsh/tools/guard.json 的 allowDomains）` }
              }
              res = await fetch(cur.toString(), { redirect: 'manual', headers: { 'user-agent': 'dsh-moyu-fetch/1' } })
              const code = res.status
              if (code >= 300 && code < 400) {
                const loc = res.headers.get('location')
                if (!loc) break
                cur = new URL(loc, cur)
                hop += 1
                continue
              }
              break
            }
            if (!res) return { ok: false, error: '请求没有返回' }
            if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }

            const len = Number(res.headers.get('content-length') || 0)
            if (len && len > limit) {
              logFetch({ ok: false, url: cur.toString(), error: 'too-large', bytes: len })
              return { ok: false, error: `文件太大（${Math.round(len / 1048576)} MB > 上限 ${limitMB} MB）` }
            }

            const dir = path.join(g.playground, 'downloads')
            fs.mkdirSync(dir, { recursive: true })
            const target = path.join(dir, String(args.name || safeName(cur.toString())))

            try {
              const reader = res.body.getReader()
              const chunks = []
              let total = 0
              for (;;) {
                const { done, value } = await reader.read()
                if (done) break
                total += value.length
                if (total > limit) {
                  try { await reader.cancel() } catch (err) {}
                  try { if (fs.existsSync(target)) fs.unlinkSync(target) } catch (err) {}
                  logFetch({ ok: false, url: cur.toString(), error: 'too-large-stream', bytes: total })
                  return { ok: false, error: `下载超过上限 ${limitMB} MB，已中止且不保留半截文件` }
                }
                chunks.push(Buffer.from(value))
              }
              fs.writeFileSync(target, Buffer.concat(chunks))
              logFetch({ ok: true, url: cur.toString(), path: target, bytes: total })
              return { ok: true, path: target, bytes: total, url: cur.toString() }
            } catch (err) {
              logFetch({ ok: false, url: cur.toString(), error: 'write-failed:' + String((err && err.message) || err) })
              return { ok: false, error: '写文件失败：' + String((err && err.message) || err) }
            }
          },
        }))
      } catch (err) {
        try { console.warn('[dsh-moyu-badge] moyu_fetch 注册失败：' + String((err && err.message) || err)) } catch (e2) {}
      }

      // 执行封装：第一类工具。工作目录锁在游乐场里，带超时，脚本/程序只能从这里起。
      // 它防的是"误伤 / 挂死 / 到处乱起进程"，防不住"程序自己开绝对路径"——那需要沙箱。
      try {
        const guardFile2 = fs.existsSync(path.join(MOYU_DIR, 'tools', 'guard.json')) ? path.join(MOYU_DIR, 'tools', 'guard.json') : path.join(os.homedir(), '.dsh', 'tools', 'guard.json')
        const runLog = path.join(os.homedir(), '.dsh', 'tools', 'run.log')
        const readRunGuard = () => {
          const j = JSON.parse(fs.readFileSync(guardFile2, 'utf8'))
          const m = Number(j.runTimeoutMs)
          return {
            playground: typeof j.playground === 'string' && j.playground ? j.playground : path.join(os.homedir(), 'AkPlay'),
            runAllow: Array.isArray(j.runAllow) ? j.runAllow.map((s) => String(s).toLowerCase()) : ['node', 'python'],
            timeoutMs: Number.isFinite(m) && m > 0 ? m : 60000,
          }
        }
        const logRun = (row) => {
          try {
            fs.mkdirSync(path.dirname(runLog), { recursive: true })
            fs.appendFileSync(runLog, JSON.stringify({ ts: new Date().toISOString(), ...row }) + '\n', 'utf8')
          } catch (err) {}
        }
        const inside = (p, root) => p === root || p.startsWith(root + path.sep)

        disposers.push(registerTool(ctx, {
          name: 'moyu_run',
          description:
            '在游乐场（~/AkPlay）里执行一个程序或脚本，带超时（默认 60s，到点连子进程一起杀）。要开长驻窗口（游戏这类）就带 detached: true，起完立刻返回、不等待也不杀。工作目录必须在游乐场里；可执行文件是路径时也必须在游乐场里，是名字时必须在 guard.json 的 runAllow 里（node/python/py）。受摸鱼模式的「跑」边界管理。',
          parameters: {
            type: 'object',
            properties: {
              exe: { type: 'string', description: '可执行文件：游乐场内的相对/绝对路径，或 runAllow 里的名字（node/python/py）' },
              args: { type: 'array', items: { type: 'string' }, description: '参数数组' },
              cwd: { type: 'string', description: '可选：相对游乐场的工作目录，默认游乐场根' },
              timeoutMs: { type: 'number', description: '可选：超时毫秒，默认取 guard.json 的 runTimeoutMs' },
              detached: { type: 'boolean', description: '可选：true=起完立刻返回、不等待也不杀（游戏这类长驻前台程序用）。默认 false，等它跑完。' },
            },
            required: ['exe'],
          },
          output: {
            schema: {
              type: 'object',
              properties: {
                ok: { type: 'boolean' },
                exit: { type: 'number' },
                timedOut: { type: 'boolean' },
                stdout: { type: 'string' },
                stderr: { type: 'string' },
                error: { type: 'string' },
                ms: { type: 'number' },
                detached: { type: 'boolean' },
              },
            },
            render: (_a, v) =>
              v.detached
                ? [{ type: 'text', text: '已起来（后台常驻）· ' + v.ms + 'ms\n' + (v.message || '') }]
                : v.ok
                ? [{ type: 'text', text: `exit ${v.exit} · ${v.ms}ms` + (v.stdout ? '\n' + v.stdout : '') + (v.stderr ? '\n[stderr] ' + v.stderr : '') }]
                : [{
                    type: 'text',
                    text: (v.error ? '没执行：' + v.error : `exit ${v.exit} · ${v.ms}ms（失败）`) +
                      (v.stdout ? '\n[stdout] ' + v.stdout : '') +
                      (v.stderr ? '\n[stderr] ' + v.stderr : ''),
                  }],
          },
          execute(args) {
            const st = readState()
            const cfg = readConfig() || {}
            const bounds = readBoundaries(st, cfg)
            if (st && st.mode === 'moyu' && !bounds.exec) {
              logRun({ ok: false, exe: String(args.exe || ''), error: 'boundary-exec' })
              return { ok: false, error: '摸鱼模式的「跑」已关闭，不能执行。要恢复，用 moyu_boundary 把 exec 打开。' }
            }

            let g
            try { g = readRunGuard() } catch (err) {
              return { ok: false, error: 'guard.json 读不出来（失败关闭）：' + String((err && err.message) || err) }
            }

            const scope = bounds.scope
            // 2026-11-16 用户定：自定义地盘必须写 user: "moyu"。
            // 不写就等于「用管理员身份跑」，那是唯一能把管理员权限重新打开的口子，所以直接拒。
            if (!scope || scope.user !== 'moyu') {
              return { ok: false, error: '这块地盘没写 user: "moyu"，不给跑——不换受限身份就等于用管理员跑，等于没有边界。照边界模板.md 补上这个字段。' }
            }
            const roots = (scope && scope.write) || []
            if (!roots.length) return { ok: false, error: '这块地盘没配能写的目录，跑不起来' }
            const raw = String(args.exe || '').trim()
            if (!raw) return { ok: false, error: 'exe 不能为空' }

            // 固定路径名单：给装在游戏库、进不了地盘目录的程序用。
            // 只认整条路径全等，且挡掉 shell / 系统工具——往名单里写 cmd 也不生效。
            const DENY_EXE = /^(cmd|powershell|pwsh|wscript|cscript|mshta|rundll32|regsvr32|explorer|regedit|taskmgr|schtasks|net|net1|sc|wmic|certutil|bitsadmin|conhost|bash|sh)\.exe$/i
            const runPaths = ((scope && scope.runPaths) || []).map((x) => path.resolve(String(x)).toLowerCase())

            let exe = raw
            let pinnedDir = ''
            if (raw.indexOf('/') >= 0 || raw.indexOf('\\') >= 0) {
              const cand = path.resolve(roots[0], raw)
              const candLc = cand.toLowerCase()
              if (roots.some((r) => inside(cand, r))) {
                exe = cand
                if (!fs.existsSync(exe)) return { ok: false, error: '文件不存在：' + exe }
              } else if (runPaths.indexOf(candLc) >= 0) {
                if (DENY_EXE.test(path.basename(cand))) return { ok: false, error: '这块地盘不许起这种程序：' + path.basename(cand) }
                exe = cand
                pinnedDir = path.dirname(cand)
                if (!fs.existsSync(exe)) return { ok: false, error: '文件不存在：' + exe }
              } else {
                return { ok: false, error: '这个程序既不在地盘里、也不在固定名单里：' + cand }
              }
            } else {
              const progBase = raw.replace(/\.exe$/i, '').toLowerCase()
              const allowRun = (scope && scope.run) || []
              if (allowRun.indexOf(progBase) < 0) {
                return { ok: false, error: `这个程序不在地盘「${scope ? scope.label : '?'}」的程序名单里：${raw}（名单：${allowRun.join(' / ') || '空'}）` }
              }
              // 裸名字要自己找路径：DSH 主进程的 PATH 里没有 node（实测 where node 找不到）
              let found = ''
              // L3：地盘的受限账号读不到 ~/.dsh 下的运行时，所以程序用 l3-programs.json 里
              // 专门给 moyu 准备的那份（node 复制到 ~/.dsh/moyu/bin，python 单独授过 RX）。
              if (scope && scope.user) {
                try {
                  const mapTxt = fs.readFileSync(path.join(MOYU_DIR, 'l3-programs.json'), 'utf8').replace(/^\uFEFF/, '')
                  const map = JSON.parse(mapTxt)
                  const k = raw.replace(/\.exe$/i, '').toLowerCase()
                  const hit = map[k]
                  if (hit && fs.existsSync(hit)) found = hit
                } catch (err) {}
              }
              if (!found && raw.toLowerCase() === 'node') {
                try {
                  const np = fs.readFileSync(path.join(MOYU_DIR, 'node-path.txt'), 'utf8').trim()
                  if (np && fs.existsSync(np)) found = np
                } catch (err) {}
                if (!found && process.env.DSH_NODE && fs.existsSync(process.env.DSH_NODE)) found = process.env.DSH_NODE
                // 2026-11-17：没有 bin\node.exe 副本时，用 Electron 本体当 node（run-as.ps1 里已 set ELECTRON_RUN_AS_NODE=1）。
                // 这样装上就能跑，不用先复制一份 node。
                if (!found && process.execPath && /deepseek harness/i.test(process.execPath) && fs.existsSync(process.execPath)) {
                  try {
                    const probe = execFileSync(process.execPath, ['-e', 'console.log(process.version)'], {
                      env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }),
                      encoding: 'utf8', timeout: 15000, windowsHide: true,
                    }).trim()
                    if (/^v\d/.test(probe)) found = process.execPath
                  } catch (err) {}
                }
              }
              if (!found) {
                try {
                  const outWhere = execFileSync('where.exe', [raw], { windowsHide: true, encoding: 'utf8' })
                  const first = String(outWhere || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0]
                  if (first && fs.existsSync(first)) found = first
                } catch (err) {}
              }
              if (!found) return { ok: false, error: `找不到程序：${raw}（PATH 里没有，也不在 node-path.txt 里）` }
              exe = found
            }

            let cwd
            const cwdArg = String(args.cwd || '.')
            if (pinnedDir) {
              cwd = cwdArg === '.' ? pinnedDir : path.resolve(roots[0], cwdArg)
              if (!inside(cwd, pinnedDir) && !roots.some((r) => inside(cwd, r))) {
                return { ok: false, error: '固定名单里的程序，工作目录只能是它自己那一层或地盘里：' + cwd }
              }
            } else {
              cwd = path.resolve(roots[0], cwdArg)
              if (!roots.some((r) => inside(cwd, r))) return { ok: false, error: '工作目录不在这块地盘里：' + cwd }
            }

            const argv = Array.isArray(args.args) ? args.args.map((s) => String(s)) : []
            const scopeCap = (scope && scope.timeoutMs) || g.timeoutMs
            const tmo = Number(args.timeoutMs) > 0 ? Math.min(Number(args.timeoutMs), scopeCap, 300000) : scopeCap

            // L3（2026-11-16）：地盘指定了受限账号 → 交给 run-as.ps1 以 moyu 身份起。
            // 这一层不靠工具名拦，靠 Windows 自己的 ACL 与防火墙：写不到地盘外、一律出不了网、
            // 也读不到 ~/.dsh 下的配置和凭据。跑 node/python 仍然是任意代码，但代码被关在笼子里。
            if (scope && scope.user) {
              const runsDir = path.join(MOYU_DIR, 'freetime', 'runs')
              try { fs.mkdirSync(runsDir, { recursive: true }) } catch (err) {}
              const rid = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
              const outBase = path.join(runsDir, rid)
              const argFile = outBase + '.json'
              const helper = path.join(MOYU_DIR, 'run-as.ps1')
              const tmoSec = Math.max(1, Math.ceil(tmo / 1000))
              // detached=true：起完就返回（游戏这类长驻前台程序）。默认 false，保持原来的「等它跑完」。
              const detached = args.detached === true
              const startedAt = Date.now()
              if (!fs.existsSync(helper)) return { ok: false, error: 'L3 的 run-as.ps1 不见了：' + helper }
              const acctFile = path.join(MOYU_DIR, 'secrets', 'moyu-account.json')
              if (!fs.existsSync(acctFile)) {
                return { ok: false, error: '这台机器还没装受限账号：先跑 ' + path.join(MOYU_DIR, 'install-l3.ps1') + '（不会偷偷用管理员身份跑）' }
              }
              try {
                fs.writeFileSync(argFile, JSON.stringify(argv), 'utf8')
              } catch (err) {
                return { ok: false, error: '写不了参数文件：' + String((err && err.message) || err) }
              }
              const r = spawnSync('powershell.exe', [
                '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helper,
                '-Exe', exe, '-ArgsJson', argFile, '-Cwd', cwd,
                '-TimeoutSec', String(tmoSec), '-OutBase', outBase,
                // detached：长驻前台程序（游戏）起完就把控制权还给我，不等待、不杀。
                ...(detached ? ['-Detach'] : []),
              ], { windowsHide: true, encoding: 'utf8', timeout: detached ? 60000 : (tmoSec + 25) * 1000 })
              const rms = Date.now() - startedAt
              if (detached) {
                for (const p2 of [outBase + '.json', outBase + '.cmd', outBase + '.out', outBase + '.err']) {
                  try { fs.unlinkSync(p2) } catch (err) {}
                }
                logRun({ ok: true, exe, args: argv, exit: 0, ms: rms, asUser: 'moyu', detached: true })
                return { ok: true, detached: true, ms: rms, message: '已在后台起来，不会自己退、也不用等它结束。拿 moyu_desktop 去点窗口，或者按窗口标题找它。' }
              }
              const rd = (p2) => { try { return fs.readFileSync(p2, 'utf8') } catch (err) { return '' } }
              const stOut = rd(outBase + '.out').trim()
              const stErr = rd(outBase + '.err').trim()
              for (const p2 of [outBase + '.json', outBase + '.cmd', outBase + '.out', outBase + '.err']) {
                try { fs.unlinkSync(p2) } catch (err) {}
              }
              const exitCode = typeof r.status === 'number' ? r.status : -1
              const timedOut = exitCode === 124
              const cap2 = 8000
              const res = { ok: !timedOut && exitCode === 0, exit: exitCode, timedOut, stdout: stOut.slice(0, cap2), stderr: stErr.slice(0, cap2), ms: rms }
              // 受限账号穿不过 ~/.dsh 这一层：脚本写在 .dsh 下面就 lstat 不到（EPERM）。
              // 与其让人对着 EPERM 猜，直接说怎么办（2026-11-17 用户定 A 方案）。
              if (!res.ok && /EPERM|lstat/i.test(res.stderr || '')) {
                // 直接写进 stderr：工具结果的字段是固定的，额外的 hint 字段到不了模型面前。
                res.stderr = (res.stderr + '\n[提示] 脚本别放 ~/.dsh 里：受限账号穿不过那一层（lstat 要读属性）。把 .js/.py 写到 ~/AkPlay/ 下再跑，或者用 -e 单行内联。').trim()
              }
              if (timedOut) res.error = `超时 ${tmo}ms，进程树已杀`
              else if (r.error) res.error = 'L3 起不来：' + String((r.error && r.error.message) || r.error)
              logRun({ ok: res.ok, exe, args: argv, exit: res.exit, timedOut, ms: rms, asUser: 'moyu' })
              return res
            }
            const childEnv = Object.assign({}, process.env)
            try { childEnv.PATH = path.dirname(exe) + ';' + String(childEnv.PATH || '') } catch (err) {}

            return new Promise((resolve) => {
              let child
              try {
                child = spawn(exe, argv, { cwd, env: childEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false })
              } catch (err) {
                resolve({ ok: false, error: '起不来：' + String((err && err.message) || err) })
                return
              }
              let out = ''
              let errOut = ''
              let timedOut = false
              const cap = 8000

              child.stdout.on('data', (b) => { if (out.length < cap) out += b.toString('utf8') })
              child.stderr.on('data', (b) => { if (errOut.length < cap) errOut += b.toString('utf8') })

              const timer = setTimeout(() => {
                timedOut = true
                try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }) } catch (e2) {}
              }, tmo)

              child.on('error', (e) => {
                clearTimeout(timer)
                resolve({ ok: false, error: '执行出错：' + String((e && e.message) || e) })
              })
              child.on('close', (code) => {
                clearTimeout(timer)
                const ms = Date.now() - started
                const res = {
                  ok: !timedOut && code === 0,
                  exit: typeof code === 'number' ? code : -1,
                  timedOut,
                  stdout: out.trim().slice(0, cap),
                  stderr: errOut.trim().slice(0, cap),
                  ms,
                }
                if (timedOut) res.error = `超时 ${tmo}ms，进程树已杀`
                logRun({ ok: res.ok, exe, args: argv, exit: res.exit, timedOut, ms })
                resolve(res)
              })
            })
          },
        }))
      } catch (err) {
        try { console.warn('[dsh-moyu-badge] moyu_run 注册失败：' + String((err && err.message) || err)) } catch (e2) {}
      }

    // 2026-11-17：给工具执行体包一层。
//   异常不再往顶层抛（'base is not defined' 那次把所有 moyu_run 都拖死了），
//   而是变成一条结构化失败，只有这一个调用失败。

  ctx.tools.guard((exec) => {
        try {
          const st = readState()
          if (!st || st.mode !== 'moyu') return
          const cfg = readConfig() || {}
          const name = String((exec && exec.name) || '')
          if (!name) return
          try {
            if (!GUARD_SEEN.has(name)) {
              GUARD_SEEN.add(name)
              const p = path.join(MOYU_DIR, 'logs', 'guard-seen.log')
              fs.mkdirSync(path.dirname(p), { recursive: true })
              fs.appendFileSync(p, new Date().toISOString() + ' ' + name + "\r\n")
            }
          } catch (err) {}


          // ① 边界：跑 + 联。读 state.boundaries（本次摸鱼的临时开关），优先于 config.json。
          //    config 是默认值，state 是这次的方向盘；退出摸鱼时 state.boundaries 会被清掉。
          // ④ 永久禁：不跟任何开关共享，摸鱼时一律不给
          if (MOYU_BAN.has(name)) {
            logDenial(name, 'moyu-ban')
            return '摸鱼模式不给用 ' + name + '：' + (MOYU_BAN_REASON[name] || '这个工具能绕开边界。') 
          }

          // ① 白名单：没登记的一律拒
          if (!allowedTool(name, cfg)) {
            logDenial(name, 'tool-not-allowed')
            return '摸鱼模式不放行这个工具：' + name + '（白名单里没有）。要放行就把它加进 ~/.dsh/moyu/freetime/allow-extra.json（数组），或者退出摸鱼再用。'
          }

          // ③ 边界快照比对：state.boundaries 或 config 的 permissions/scopes 被改过 → 立刻退出
          try {
            const fp = boundaryFingerprint(st.boundaries)
            const sp = scopeFingerprint(cfg)
            if (!st.boundaryStamp || !st.scopeStamp) {
              st.boundaryStamp = fp
              st.scopeStamp = sp
              try { fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2) + '\n', 'utf8') } catch (err) {}
            } else if (st.boundaryStamp !== fp || st.scopeStamp !== sp) {
              logDenial(name, 'boundary-tampered')
              tamperExit(st, 'boundaries-changed-outside-moyu_boundary')
              return '摸鱼的边界被人从外面改过了，我已经退出摸鱼并记下来（freetime/tamper.log）。要重新开始，正常进一次。'
            }
          } catch (err) {
            // 指纹算不出来就当「这一项没做」，别让它把整次调用判死
            logGuardError('stamp', err)
          }

          const bounds = readBoundaries(st, cfg)
          if (SHELL_TOOLS.has(name)) {
            if (!bounds.exec) {
              logDenial(name, 'boundary-exec')
              return '摸鱼模式的「跑」已关闭：现在不能执行任何命令。要恢复，用 moyu_boundary 工具选一块地盘（moyu_exit 不走 shell，随时可用）。'
            }
            if (name !== 'moyu_run') {
              logDenial(name, 'boundary-exec-shell')
              return '摸鱼模式的「跑」只在地盘「' + (bounds.scope ? bounds.scope.label : bounds.execName) + '」里生效：' + name + ' 这种直接开 shell 的不给，只能用 moyu_run 起白名单里的程序。'
            }
          }
          const isNetTool = NET_TOOLS.has(name) || NET_PREFIX.some((p) => name.indexOf(p) === 0) || (name.indexOf('mcp__') === 0 && NET_MCP_PATTERN.test(name))
          if (!bounds.net && isNetTool) {
            // 「联」管的是往外走：联网、对外发话。QQ 的只读与会话管理（看未读、等消息、收尾、
            // 标已读、读写唤醒配置）走的是本机 3110 端口，不会惊动任何人，只要社交没关成 off
            // 就放它过去——否则关「联」等于我聋了，只能干等用户来叫（2026-11-07 用户同意这样改）。
            const qqLocal = bounds.social !== 'off' && name.indexOf('mcp__snowluma__') === 0
            const qqLocalOk = qqLocal && (MCP_READ_VERB.test(name.split('__').pop() || '') || QQ_SESSION_OK.test(name))
            if (!qqLocalOk) {
              logDenial(name, 'boundary-net')
              return '摸鱼模式的「联」已关闭：现在不能联网或对外发消息。要恢复，用 moyu_boundary 工具打开。'
            }
          }

          // ② 文件层（2026-11-16）：写只许 freetime/ 与 playground/；readDenied 里的路径不许读。
          const pathsHere = PATH_ARG_TOOLS.has(name) ? toolPaths((exec && exec.arguments) || (exec && exec.args) || {}) : []
          if (pathsHere.length) {
            if (WRITE_TOOLS.has(name)) {
              const bad = pathsHere.find((p) => !underRoot(p, WRITE_SCOPE))
              if (bad) {
                logDenial(name, 'boundary-write')
                return '摸鱼模式下只能写 ~/.dsh/moyu/freetime/ 和 ~/AkPlay/；' + bad + ' 不在里面。'
              }
              for (const p of pathsHere) logWrite(name, p)
            }
            const hidden = pathsHere.find((p) => readDeniedHit(p, cfg))
            if (hidden) {
              logDenial(name, 'boundary-read')
              return '摸鱼模式：' + hidden + ' 是凭据/会话数据，现在不读。'
            }
          }

          // 严格档：动手前先留一句「要干什么」。读和想不管，只拦会改变东西或对外的动作。
          // 2026-11-17：严格档自己算不出来时，只让严格档失效（记一笔），不连累别的检查。
          let strictNow = { level: 0 }
          try {
            strictNow = strictOf(cfg)
          } catch (err) {
            logGuardError('strict', err)
          }
          const NEEDS_INTENT = new Set(['write', 'edit', 'moyu_run', 'moyu_fetch', 'moyu_web', 'moyu_desktop'])
          // 例外：写 intent.md 本身不能要 intent，否则第一次进严格档永远写不出那句话（鸡生蛋）。
          const lowPaths = pathsHere.map((p) => String(p).toLowerCase())
          const writingIntent = WRITE_TOOLS.has(name) &&
            lowPaths.some((p) => p.indexOf('freetime') >= 0 && p.endsWith('intent.md'))
          if (strictNow.level >= 1 && NEEDS_INTENT.has(name) && !intentRecent() && !writingIntent) {
            logDenial(name, 'strict-need-intent')
            return '严格档：动手之前先在 ~/.dsh/moyu/freetime/intent.md 写一行「我要干什么、为什么」（20 分钟内有效）。'
          }

          if (SOCIAL_PATTERN.test(name)) {
            // 社交三态：off 全拒；owner 只放「发给用户的私聊」；all 全放。
            // 以前这里一律拒，摸鱼时用户不在电脑前没法批准，想说的话就被卡死（2026-11-05 踩过）。
            const socialMode = bounds.social
            const allowed = socialMode === 'all' || (socialMode === 'owner' && isOwnerPrivateSend(exec))
            if (!allowed) {
              logDenial(name, socialMode === 'off' ? 'social-off' : 'social-owner-only')
              return socialMode === 'off'
                ? '摸鱼模式：社交已关闭，现在不能发消息、发动态、加好友。要恢复，用 moyu_boundary 把 social 设成 owner。'
                : '摸鱼模式：现在只放行「发给用户的私聊」；群、B站、别人一律不动。要放宽，用 moyu_boundary 把 social 设成 all。'
            }
          }

          if (name.indexOf('mcp__') === 0) {
            // 社交放行过的（social=all，或 owner 且发给用户的私聊）不再走 MCP 默认拒。
            const socialOk = SOCIAL_PATTERN.test(name) && (bounds.social === 'all' || (bounds.social === 'owner' && isOwnerPrivateSend(exec)))
            const seg = name.split('__').pop() || name
            if (!socialOk && !MCP_READ_VERB.test(seg) && !QQ_SESSION_OK.test(name)) {
              logDenial(name, 'mcp-default-deny')
              return '摸鱼模式：MCP 工具默认不放行，只放只读的（get / list / status / query / search / read 这类）。要发消息、改设置、传东西，先问主人。'
            }
          }

          // ①b 边界：动（键鼠）。desktop.ps1 是走 shell 调的，所以这里认的是命令行里有没有它。
          //    真正拦得住的在 desktop.ps1 自己的守卫里，这里是第二道（改不了那个脚本时也能挡）。
          if (!bounds.motion) {
            const argText = (() => {
              try { return JSON.stringify((exec && exec.args) || {}) } catch (err) { return '' }
            })().toLowerCase()
            const byTool = name === 'moyu_desktop'
            const byShell = SHELL_TOOLS.has(name) && argText.indexOf('desktop.ps1') >= 0
            if (byTool || byShell) {
              logDenial(name, 'boundary-motion')
              return '摸鱼模式的「动」已关闭：现在不能操作鼠标键盘。要恢复，用 moyu_boundary 工具打开 motion。'
            }
          }

          // ② 拒绝权：三态在 shouldDeny 里判断（off 不管 / deny 拦对外 / judge 不拦）
          if (shouldDeny(name, cfg)) {
            const mode = (cfg.rejection && cfg.rejection.mode) || 'off'
            if (mode === 'deny') {
              logDenial(name, 'deny-mode')
              return '摸鱼模式（一律拒活儿）：现在不做对外动作。想让我干活，先退出摸鱼模式。'
            }
          }
        } catch (err) {
          // 2026-11-17：以前这里直接 return（等于放行）。守卫自己坏了应该收紧，不是放开。
          logGuardError('guard', err)
          return '摸鱼模式的守卫自己出错了（' + ((err && err.message) || err) + '），这次先拒。详细记在 freetime/guard-error.log；要退出摸鱼用 moyu_exit。'
        }
      })
    })


    // ④ 启动自检：交给 checkIncident（可单测，见下面的导出）
    setTimeout(() => {
      try { checkIncident(MOYU_DIR) } catch (err) {}
    }, 10000)
  },
}

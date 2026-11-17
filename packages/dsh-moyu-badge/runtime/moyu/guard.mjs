// guard.mjs — 守夜人（外 + 内 合在一个进程里）
//
// 外守：确认「活着的 DSH 不见了」超过宽限期、且 state.json 仍是 moyu，
//       就把 DSH 拉起来，再往会话里投一条恢复消息。
// 内续：DSH 活着、还在摸鱼、但距离上次唤醒太久（schedule 丢了/DSH 重启过），
//       就补一条唤醒消息。
//
// 判断只看「有没有活着的 DSH」，绝不用心跳或「会话是否 idle」当判据 ——
// 摸鱼模式两轮唤醒之间，会话本来就是 idle 的。

import { discoverDshBaseUrl } from 'file:///D:/surfcore/src/dsh-port.js'
import { NodeApiClient } from 'file:///D:/surfcore/src/dsh-client.js'
import { priceUsage } from 'file:///D:/surfcore/src/model-prices.js'
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { spawn, execSync, execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const STATE = path.join(HERE, 'state.json')
const CONFIG = path.join(HERE, 'config.json')
const LOGDIR = path.join(HERE, 'logs')
const LOG = path.join(LOGDIR, 'guard.log')
const STOP = path.join(HERE, 'guard.stop.flag')
const PLAY_WATCH = path.join(HERE, 'tools', 'playwatch.mjs')
const APP = 'E:\\dsh\\DeepSeek Harness.exe'

const POLL_MS = 20000
const GRACE_MS = 60000
const COOLDOWN_MS = 5 * 60000
const READY_MAX_MS = 150000
const WORKSPACE_HINT = 'default-workspace'
// 内续的间隔与次数上限不再写死，见 maybeWake()：从 config.json 的 wake.{intervalMinutes,maxCount} 读

let downSince = null
let missStreak = 0
let recovering = false
let idleRounds = 0
let driftCheckedFor = ''
let lastPlayCheck = 0
let playRemindLogged = false
// 递减：连续没动静时，内续越喊越稀（30 → 30 → 60 → 120 → 120…）
// 「有没有动静」看会话文件 mtime——我干活/说话都会写它；我根本不在时它不动。
const SESSIONS_DIR = path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'sessions')
const ACTIVE_WINDOW_MS = 5 * 60000

function newestSessionMtime() {
  try {
    let newest = 0
    const stack = [SESSIONS_DIR]
    while (stack.length) {
      const dir = stack.pop()
      let entries
      try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
      for (const e of entries) {
        const full = path.join(dir, e.name)
        if (e.isDirectory()) { stack.push(full); continue }
        if (!e.name.endsWith('.zstd')) continue
        try {
          const m = statSync(full).mtimeMs
          if (m > newest) newest = m
        } catch {}
      }
    }
    return newest
  } catch { return 0 }
}

function backoffMultiplier(streak) {
  if (streak <= 2) return 1
  if (streak === 3) return 2
  return 4
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

let beatBucket = -1;

function localIso(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const abs = Math.abs(off)
  // 秒级即可，跟 moyu.ps1 的 Now-Stamp 保持同一格式
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`
  try { console.log(line) } catch {}
  try { appendFileSync(LOG, line + '\n') } catch {}
}

function readConfig() {
  try { return JSON.parse(readFileSync(CONFIG, 'utf8')) } catch { return null }
}

// 只在 outerOnCrashOnly 为 true 时用：查 Windows 应用日志里有没有近期崩溃记录
function crashedRecently(withinMs = 5 * 60000) {
  try {
    const script = [
      "$since = (Get-Date).AddMilliseconds(-" + withinMs + ")",
      "Get-WinEvent -FilterHashtable @{LogName='Application'; StartTime=$since; Level=2} -ErrorAction SilentlyContinue | Where-Object { $_.Message -match 'DeepSeek Harness|dsh' } | Select-Object -First 1 | ForEach-Object { $_.TimeCreated.ToString('o') }"
    ].join('; ')
    const out = execSync(`powershell.exe -NoProfile -Command "${script}"`, { encoding: 'utf8', windowsHide: true })
    return out.trim().length > 0
  } catch { return false }
}

function readState() {
  try { return JSON.parse(readFileSync(STATE, 'utf8')) } catch { return null }
}
// 撤安全锁：调 acl.ps1 unlock；失败只记一行日志，不影响退出
function unlockAcl() {
  try {
    const root = HERE
    const ps1 = path.join(root, 'acl.ps1')
    if (!existsSync(ps1)) return
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, 'unlock-safe'], { timeout: 60000, windowsHide: true })
    log('acl unlocked')
  } catch (e) {
    // 2026-11-09：以前这里静默吞掉，11-07 那 19 个文件没撤掉也看不出来。
    // acl.ps1 unlock-safe 已经把残留写回 state/acl.json 并 exit 1，这里 loudly 报。
    log('acl unlock FAILED: ' + (e && e.message ? e.message : String(e)))
    try {
      const rec = path.join(root, 'state', 'acl.json')
      if (existsSync(rec)) log('acl leftovers kept in ' + rec)
    } catch {}
  }
}


// 到点退出任务由 moyu.ps1 注册；守夜人自己退出时也得把它撤掉，
// 否则任务会在稍后触发一次「空退」（exit-task.ps1 会自己判断 mode，无害但噪音）。
function removeExitTask() {
  try { execFileSync('schtasks', ['/Delete', '/TN', 'moyu-exit', '/F'], { timeout: 20000, windowsHide: true }) } catch {}
}

function writeState(s) {
  try { writeFileSync(STATE, JSON.stringify(s, null, 2), 'utf8') } catch (e) { log('writeState failed: ' + e.message) }
}

async function discover() {
  try { return await discoverDshBaseUrl() } catch (e) { log('discover error: ' + e.message); return null }
}

// 单次 RPC 的上限。DSH 客户端默认 30s，跟 tick 的硬上限同尺，
// 一次慢调用就能把整轮顶爆（2026-11-16 那条 tick timeout 就是这么来的）。
// 收到 8s：够回环上用，超了就当这次发现/投递失败，下一轮再来。
const CALL_TIMEOUT_MS = 5000
function makeClient(base) {
  return new NodeApiClient(base, CALL_TIMEOUT_MS, {
    token: null,
    tokenExplicit: false,
    allowRemote: false
  })
}

async function pickSession(api) {
  const res = await api.callUnary('session/list', {})
  const items = res?.result?.value?.items ?? res?.value?.items ?? []
  if (!items.length) return null
  const hit = items.find((x) => String(x.cwd ?? '').toLowerCase().includes(WORKSPACE_HINT))
  return hit ?? items[0]
}

async function postToSession(base, text, allowBusy = false) {
  const api = makeClient(base)
  await api.ensureAuth()
  const target = await pickSession(api)
  if (!target) { log('no session to post to'); return false }
  // 会话正在跑一轮时，投进去只会排队，等这一轮结束才送达 —— 那多半已经过期了。
  // 内续跳过、下一拍再看（我一结束这轮本来就算醒着）；外守的恢复消息 allowBusy=true，不管忙不忙都送到。
  if (!allowBusy && target.running === true) { log('session busy (running); wake skipped this tick'); return false }
  const r = await api.sessions.prompt({
    sessionId: target.sessionId,
    mode: 'queue',
    content: [{ type: 'text', text }]
  })
  const ok = r?.result?.ok !== false
  log(`prompt -> ${target.sessionId}: ok=${ok}`)
  return ok
}


// ── 预算：按 DSH 自己统计的用量折钱 ──────────────────────────
// 以前 budgetUsed 只有我自己调 spend 才会涨，不调永远是 0。
// 现在每 60 秒读一次累计用量，跟 enter 时的基准比，超了就直接退出。
const MODEL = 'deepseek-flash'
let lastSpendAt = 0
let lastUsageWarnAt = 0

async function usageSnapshot(base) {
  const api = makeClient(base)
  await api.ensureAuth()
  const res = await api.callUnary('session/list', {})
  const items = res?.result?.value?.items ?? res?.value?.items ?? []
  const hit = items.find((x) => String(x.cwd ?? '').toLowerCase().includes(WORKSPACE_HINT)) ?? items[0]
  if (!hit) return null
  // DSH 的内部结构一旦改版，这里会拿到 undefined；以前会静默变 0（预算永不触发），
  // 现在显式抛错，让 enforceBudget 记一条日志，别装作没事。
  if (!hit.projections || !hit.projections.values || !hit.projections.values.tokenUsage) {
    throw new Error('tokenUsage-missing')
  }
  const u = hit.projections.values.tokenUsage
  return {
    sessionId: hit.sessionId ?? null,
    uncachedInputTokens: u.uncachedInputTokens ?? 0,
    outputTokens: u.outputTokens ?? 0,
    cacheReadTokens: u.cacheReadTokens ?? 0,
    cacheWriteTokens: u.cacheWriteTokens ?? 0
  }
}

async function enforceBudget(st, base) {
  const cap = Number(st?.budgetYuan) || 0
  if (cap <= 0) return
  if (Date.now() - lastSpendAt < 60000) return
  lastSpendAt = Date.now()
  let baseSnap = null
  try { baseSnap = st.usageBase ? JSON.parse(st.usageBase) : null } catch { baseSnap = null }
  if (!baseSnap || !baseSnap.sessionId) return
  let now = null
  try {
    now = await usageSnapshot(base)
  } catch (err) {
    const msg = String((err && err.message) || err)
    if (Date.now() - lastUsageWarnAt > 600000) {
      lastUsageWarnAt = Date.now()
      log('budget: 读不到用量（' + msg + '），这一轮不强制' +
        (msg === 'tokenUsage-missing' ? '；多半是 DSH 升级改了内部结构，要修 usageSnapshot' : ''))
      try { st.usageError = msg; writeState(st) } catch (e2) {}
    }
    return
  }
  if (!now) return
  if (now.sessionId !== baseSnap.sessionId) {
    // DSH 重启过：累计用量归零，老基准没意义了。用当前快照当新基准，
    // 这样窗口中间重启一次也不会让预算从此失效。
    st.usageBase = JSON.stringify(now)
    writeState(st)
    log('budget: session changed after restart; usage baseline reset')
    return
  }
  const d = (k) => Math.max(0, (now[k] ?? 0) - (baseSnap[k] ?? 0))
  const buckets = { cacheMiss: d('uncachedInputTokens'), cacheHit: d('cacheReadTokens'), cacheWrite: d('cacheWriteTokens'), output: d('outputTokens'), reasoning: 0 }
  const { cost } = priceUsage(buckets, { model: MODEL, at: Date.now() })
  const used = Math.max(Number(st.budgetUsed) || 0, Math.round(cost.total * 10000) / 10000)
  if (used !== (Number(st.budgetUsed) || 0)) { st.budgetUsed = used; writeState(st) }
  if (used >= cap) {
    // 先收尾再改状态：summary 要读「这一趟」的 state，晚了就变成 code 了。
    try {
      execFileSync(process.execPath, [path.join(HERE, 'tools', 'session-summary.mjs'), '--reason', 'budget'], { encoding: 'utf8', timeout: 20000, windowsHide: true })
    } catch (e) { log('summary failed: ' + e.message) }
    st.mode = 'code'
    st.sessionEnded = localIso()
    st.usageBase = null
    writeState(st)
    unlockAcl()
    removeExitTask()
    log('budget exceeded (' + used.toFixed(4) + ' >= ' + cap + ' CNY); auto-exit to code (acl unlocked)')
    process.exit(0)
  }
}

function fmtHM(ts) {
  const d = new Date(ts)
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}

// 内续：还在摸鱼，但太久没被唤醒
async function maybeWake(base) {
  const st = readState()
  if (!st || st.mode !== 'moyu') return

  // 「待着」：我主动选择了接下来一段时间什么都不做，这一拍不打扰
  const idleUntil = st.idleUntil ? Date.parse(st.idleUntil) : NaN
  if (Number.isFinite(idleUntil) && Date.now() < idleUntil) return

  const ends = st.sessionEnds ? Date.parse(st.sessionEnds) : NaN
  if (!Number.isFinite(ends)) return
  if (Date.now() >= ends) return

  // 间隔与次数上限都从 config.json 读，脚本里不再写死
  const cfg = readConfig()
  const baseGapMs = (Number(cfg?.wake?.intervalMinutes) || 30) * 60000
  // 递减只看「已经敲过几次、我明确应答过没有」（moyu.cmd wake 会清零）。
  // 不靠文件 mtime 猜我忙不忙——我每轮都会写会话文件，猜不准。
  const streak = Number(st.idleStreak) || 0
  const gapMs = baseGapMs * backoffMultiplier(streak)
  const maxCount = Number(cfg?.wake?.maxCount) || 0
  const used = Number(st.wakeCount) || 0
  if (maxCount > 0 && used >= maxCount) return

  const anchorRaw = st.lastWake ?? st.sessionStarted
  const anchor = anchorRaw ? Date.parse(anchorRaw) : NaN
  if (!Number.isFinite(anchor)) return

  const gapMin = Math.floor((Date.now() - anchor) / 60000)
  if (Date.now() - anchor < gapMs) return

  const leftMin = Math.max(0, Math.floor((ends - Date.now()) / 60000))
  const nth = used + 1
  const cap = maxCount > 0 ? `第 ${nth} / ${maxCount} 次` : `第 ${nth} 次`
  const hhmm = new Date().toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })
  const text = [
    '[内续] ' + cap + ' · 生成于 ' + hhmm + ' · 窗口 ' + fmtHM(st.sessionStarted) + '→' + fmtHM(ends),
    '距离上次唤醒 ' + gapMin + ' 分钟，摸鱼窗口还剩 ' + leftMin + ' 分钟。',
    '如果还在摸鱼，接着做你上次留下的事；这条消息不是主人发的。',
    (nth >= 2 && !st.idleUntil ? '（这次要是也不想动，说一句 `moyu.cmd idle -Minutes N`，我就不再敲了。）' : '')
  ].filter(Boolean).join('\n')

  try {
    if (await postToSession(base, text)) {
      st.lastWake = localIso()
      st.idleStreak = streak + 1
      st.lastHeartbeat = st.lastWake
      st.wakeCount = nth
      log('wake sent (nth=' + nth + ', streak=' + st.idleStreak + ', next gap=' + Math.round(gapMs / 60000) + 'min)')
      writeState(st)
    }
  } catch (e) {
    log('wake failed: ' + e.message)
  }
}

// 外守：DSH 真的不见了
async function recover(st) {
  const cfg = readConfig()

  if (cfg?.watch?.outer === false) {
    log('outer watch disabled in config; not launching')
    return
  }

  if (cfg?.watch?.outerOnCrashOnly === true && !crashedRecently()) {
    log('outer is crash-only and there is no crash evidence; not launching')
    return
  }

  log('recovering: launching DSH')
  try {
    const child = spawn(APP, [], { detached: true, stdio: 'ignore' })
    child.unref()
  } catch (e) {
    log('launch failed: ' + e.message)
    return
  }

  const deadline = Date.now() + READY_MAX_MS
  let base = null
  while (Date.now() < deadline) {
    await sleep(3000)
    base = await discover()
    if (base) break
  }
  if (!base) { log('recover failed: DSH never came up'); return }
  log(`DSH is back at ${base}`)

  if (!st || st.mode !== 'moyu') {
    log('not in moyu; DSH recovered, no message sent')
    return
  }

  // 端口活了不等于应用 ready
  await sleep(6000)

  const text = [
    '[外守夜人] 你刚才掉线了，我已经把 DSH 拉起来。',
    `确认掉线的时间：${localIso()}`,
    `state 里还记着摸鱼：进入于 ${st.sessionStarted ?? '?'}，原定 ${st.sessionEnds ?? '?'} 结束。`,
    '如果窗口还没过，就接着摸；已经过了就收个尾。这条消息不是主人发的。'
  ].filter(Boolean).join('\n')

  try {
    if (await postToSession(base, text, true)) {
      st.guardRecoveredAt = Date.now()
      writeState(st)
    }
  } catch (e) {
    log('recover prompt failed: ' + e.message)
  }
}

// 退出摸鱼时收掉 AI 浏览器那一套：代理进程 + 以 akweb 身份跑着的 Edge。
// 走 moyu.ps1 exit 时会先自己收一遍；走 moyu_exit 工具（硬编码出口）只能靠这里兜底。
function cleanupWeb() {
  try {
    for (const line of execFileSync('powershell.exe', ['-NoProfile', '-Command',
      "$c = Get-NetTCPConnection -LocalPort 9334 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue }; Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -like '*AkWebProfile*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; 'done'"],
      { timeout: 30000, windowsHide: true, encoding: 'utf8' }).trim().split(/\r?\n/)) {
      if (line && line !== 'done') log('cleanup: ' + line)
    }
    log('web cleanup done (proxy + AI browser)')
  } catch (e) { log('web cleanup failed: ' + e.message) }
}

let lastProxyCheck = 0
async function tick() {
  if (existsSync(STOP)) {
    log('stop flag found; exiting')
    process.exit(0)
  }

  // 摸鱼已结束：守夜人不再有用。连续两轮确认后自行退出（防止 enter/exit 时序抖动）
  const st0 = readState()
  if (!st0 || st0.mode !== 'moyu') {
    idleRounds += 1
    if (idleRounds >= 2) {
      log('not in moyu for 2 rounds; guard exiting')
      cleanupWeb()
      process.exit(0)
    }
    return
  }
  idleRounds = 0

  // AI 浏览器的闸门（代理 9334）只在摸鱼期间需要：每 60 秒看一次，挂了拉起来。
  // 退出摸鱼时由 moyu.ps1 exit 直接收掉，不留给下一趟。
  if (Date.now() - lastProxyCheck > 60000) {
    lastProxyCheck = Date.now()
    try {
      const ps = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(HERE, 'web-proxy-watch.ps1'), '-Quiet'], { windowsHide: true, stdio: 'ignore', detached: true })
      ps.unref()
    } catch {}
  }

  // 设置页和实际窗口不一致就记一笔：按 sessionStarted 去重，只记一次
  try {
    const cfgD = readConfig()
    const cfgBudget = Number(cfgD && cfgD.budget && cfgD.budget.absoluteYuan) || 0
    const cfgMin = Number(cfgD && cfgD.window && cfgD.window.durationMinutes) || 0
    const useRange = !!(cfgD && cfgD.window && cfgD.window.mode === 'timeRange')
    const actBudget = Number(st0.budgetYuan) || 0
    let actMin = 0
    if (st0.sessionStarted && st0.sessionEnds) {
      actMin = Math.round((Date.parse(st0.sessionEnds) - Date.parse(st0.sessionStarted)) / 60000)
    }
    const tag = String(st0.sessionStarted || '') + '|' + String(st0.sessionEnds || '') + '|' + String(st0.budgetYuan || '')
    if (tag && tag !== driftCheckedFor) {
      driftCheckedFor = tag
      const diffB = cfgBudget > 0 && Math.abs(actBudget - cfgBudget) > 0.001
      const diffM = !useRange && cfgMin > 0 && actMin > 0 && actMin !== cfgMin
      if (diffB || diffM) {
        log('drift: window budget=' + actBudget + '/min=' + actMin + ' vs config ' + cfgBudget + '/' + cfgMin)
      }
    }
  } catch (e) {}

  // 窗口结束就自动退出，不用等人来跑 moyu.ps1
  const endsAt = st0.sessionEnds ? Date.parse(st0.sessionEnds) : 0
  if (endsAt && Date.now() > endsAt) {
    // 同上：先收尾再改状态。
    try {
      execFileSync(process.execPath, [path.join(HERE, 'tools', 'session-summary.mjs'), '--reason', 'window-ended'], { encoding: 'utf8', timeout: 20000, windowsHide: true })
    } catch (e) { log('summary failed: ' + e.message) }
    st0.mode = 'code'
    st0.sessionEnded = localIso()
    writeState(st0)
    // 退出必须同时撤安全锁，否则文件被锁着、本人也不在了（2026-10-31 实验踩到）
    unlockAcl()
    removeExitTask()
    log('window ended; auto-exit to code (acl unlocked)')
    process.exit(0)
  }

  // 玩的时长：每分钟采一次，超上限就走同一套退出流程。
  // 采样脚本自己记账（tools/play-state.json + play-log.jsonl），不碰 state.json。
  // 采样失败一律当「没在玩」，绝不让它把守夜人卡住。
  if (Date.now() - lastPlayCheck > 60000) {
    lastPlayCheck = Date.now()
    try {
      const raw = execFileSync(process.execPath, [PLAY_WATCH], {
        encoding: 'utf8',
        timeout: 15000,
        windowsHide: true,
      })
      const pv = JSON.parse(String(raw).trim().split(/\r?\n/).pop())
      if (pv && pv.playMin >= 0) {
        if (pv.remind && !playRemindLogged) {
          playRemindLogged = true
          log(`play ${pv.playMin}min of ${pv.limitMin}min (remind at ${pv.remindMin})`)
        }
      }
      // 2026-11-16 用户定：游戏分钟只作记录，不判死。
      // 理由：摸鱼窗口已经管住总时长；钱有绝对值线，花少了多玩一会无所谓。
      // 所以到这里只留一条日志，绝不 auto-exit —— 退出摸鱼只能由时长/预算/他自己触发。
      if (pv && pv.stop) {
        log(`play ${pv.playMin}min (record only, no action; window still ${st0.sessionEnds || 'n/a'})`)
      }

    } catch (e) {
      log('playwatch failed: ' + e.message)
    }
  }

  // 每 10 分钟留一行心跳，证明循环还活着
  const beat = Math.floor(Date.now() / 600000)
  if (beat !== beatBucket) {
    beatBucket = beat
    log(`tick ok mode=moyu wakes=${st0.wakeCount ?? 0}`)
  }

  const base = await discover()

  if (base) {
    if (downSince !== null) log(`back online: ${base}`)
    downSince = null
    missStreak = 0
    await enforceBudget(readState(), base)
    await maybeWake(base)
    return
  }

  // 一次探不到不算掉：DSH 忙或被占满时探测自己也会超时。
  // 连续两次失败才进宽限期（2026-11-16 22:07 误判过一次，白拉了一遍 DSH）。
  if (downSince === null) {
    missStreak += 1
    if (missStreak < 2) {
      log('probe miss ' + missStreak + '; retry next tick')
      return
    }
    downSince = Date.now()
    log('lost DSH after ' + missStreak + ' misses; grace period started')
    return
  }

  if (Date.now() - downSince < GRACE_MS) return

  const st = readState()
  const last = Number(st?.guardRecoveredAt ?? 0)
  if (last && Date.now() - last < COOLDOWN_MS) {
    log('offline but inside cooldown; skip')
    return
  }

  // 拉起 DSH 要 40-60 秒（等端口就绪），比 tick 的 30 秒上限长得多。
  // 以前 await 在这里，每次恢复都记一条「tick timeout」——不是故障，是长度不同。
  // 现在甩出去跑，tick 立刻返回；recovering 防重复进入。
  if (recovering) { log('recovery already running; skip'); return }
  recovering = true
  downSince = null
  recover(st)
    .catch((e) => log('recover failed: ' + (e && e.message)))
    .finally(() => { recovering = false })
}

mkdirSync(LOGDIR, { recursive: true })
log('guard started')

// tick 里有没设超时的 fetch（discover / postToSession）。一旦卡住，
// tick 就永不返回，主循环跟着停——连「mode 已经变了、该退出」都判断不了。
// 之前实测：退出摸鱼后 guard 进程还在，就是卡在这一层。
// 给每轮加硬上限：超时记一笔，下一轮照常跑；被抛弃的那轮会在 TCP 层自己超时。
const TICK_TIMEOUT_MS = 30000
const SLOW_TICK_MS = 6000
function tickGuarded() {
  const t0 = Date.now()
  return Promise.race([
    tick().then((v) => {
      const ms = Date.now() - t0
      if (ms > SLOW_TICK_MS) log(`slow tick ${ms}ms`)
      return v
    }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`tick timeout ${TICK_TIMEOUT_MS}ms`)), TICK_TIMEOUT_MS)
    ),
  ])
}

while (true) {
  try { await tickGuarded() } catch (e) { log('tick error: ' + e.message) }
  await sleep(POLL_MS)
}
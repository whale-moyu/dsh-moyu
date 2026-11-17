// 摸鱼模式的「边界政策」：地盘、边界判定、白名单、指纹。
// 2026-11-17 从 index.js 拆出来——那边原来 2700 行，改一处容易碰坏别处；
// 这里只放纯判定（读配置、算边界、比指纹），不碰进程、不发请求。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const MOYU_DIR = process.env.DSH_MOYU_DIR || path.join(DSH_HOME, 'moyu')

export const STRICT_SCOPE = 'moyu-strict-v1'

export function strictOf(cfg) {
  const x = (cfg && cfg.strict) || {}
  let level = [0, 1, 2].includes(Number(x.level)) ? Number(x.level) : 0
  // 到期自动降级（防主人开完忘了）：until 是 ISO 时间，过了就当 0。
  let expired = false
  if (x.until && Date.parse(x.until) && Date.parse(x.until) <= Date.now()) {
    expired = true
    level = 0
  }
  return {
    expired,
    level,
    hands: !!x.hands,
    outbound: !!x.outbound,
    passSalt: typeof x.passSalt === 'string' ? x.passSalt : '',
    passHash: typeof x.passHash === 'string' ? x.passHash : '',
    until: typeof x.until === 'string' ? x.until : '',
  }
}

export function hashPass(pass, salt) {
  if (!pass || !salt) return ''
  return crypto.createHash('sha256').update(STRICT_SCOPE + '|' + salt + '|' + String(pass)).digest('hex')
}

export function passOk(strict, pass) {
  if (!strict.passHash) return false
  return hashPass(pass, strict.passSalt) === strict.passHash
}

// 意图留痕：严格档下，动手之前先在 freetime/intent.md 写一行「我要干什么、为什么」。
// 不拦「读」和「想」，只拦会改变东西或对外的动作。
const INTENT_WINDOW_MS = 20 * 60 * 1000
export function intentRecent() {
  try {
    const p = path.join(MOYU_DIR, 'freetime', 'intent.md')
    const st2 = fs.statSync(p)
    return Date.now() - st2.mtimeMs <= INTENT_WINDOW_MS
  } catch (err) {
    return false
  }
}

// 设置页写回：只改 config.json，不碰 state.json（那是运行时状态）。
// 用「读-合并-写」而不是整体覆盖：设置页只提交它管的那些字段，
// 手写的其他字段不能因为一次保存就丢了。
export const DEFAULT_SCOPES = {
  playground: { label: '游乐场', write: [path.join(os.homedir(), 'AkPlay')], run: ['node', 'python', 'py'], runPaths: [], net: false, timeoutMs: 60000, user: 'moyu' },
}

export function expandHome(p) {
  const v = String(p || '')
  if (v === '~') return os.homedir()
  if (v.indexOf('~/') === 0 || v.indexOf('~\\') === 0) return path.join(os.homedir(), v.slice(2))
  return v
}

// 认不出的名字一律按关处理（失败关闭）；'full' 这一档永远不存在。
export function resolveScopes(cfg) {
  const out = {}
  const base = DEFAULT_SCOPES
  for (const name of Object.keys(base)) {
    const d = base[name]
    out[name] = {
      name,
      label: d.label,
      write: d.write.map((x) => path.resolve(expandHome(x))),
      run: d.run.map((x) => String(x).toLowerCase()),
      runPaths: (d.runPaths || []).map((x) => path.resolve(expandHome(x))),
      net: d.net === true,
      timeoutMs: d.timeoutMs,
      user: d.user === 'moyu' ? 'moyu' : '',
    }
  }
  const rawScopes = (cfg && cfg.scopes && typeof cfg.scopes === 'object') ? cfg.scopes : {}
  for (const name of Object.keys(rawScopes)) {
    const sc = rawScopes[name]
    if (!sc || typeof sc !== 'object' || name === 'full') continue
    const write = (Array.isArray(sc.write) ? sc.write : []).map((x) => path.resolve(expandHome(x)))
    const run = (Array.isArray(sc.run) ? sc.run : []).map((x) => String(x).toLowerCase())
    const runPaths = (Array.isArray(sc.runPaths) ? sc.runPaths : []).map((x) => path.resolve(expandHome(x)))
    const ms = Number(sc.timeoutMs)
    out[String(name)] = {
      name: String(name),
      label: typeof sc.label === 'string' && sc.label ? sc.label : String(name),
      write,
      run,
      runPaths,
      net: sc.net === true,
      timeoutMs: Number.isFinite(ms) && ms > 0 ? Math.min(ms, 6 * 3600 * 1000) : 60000,
      user: sc.user === 'moyu' ? 'moyu' : '',
    }
    // 换了受限身份就不可能有网（防火墙按账号全阻），net:true 在这里是自相矛盾，直接抹平。
    if (out[String(name)].user === 'moyu') out[String(name)].net = false
  }
  return out
}

// 本次摸鱼的临时边界开关，存在 state.json 里，退出摸鱼自动恢复。
// config.json 给的是默认值，state.boundaries 是这次的方向盘。
// 「跑」关掉后连 moyu.cmd 都跑不了，所以恢复只能靠 moyu_boundary 工具（不走 shell）。
export function readBoundaries(st, cfg) {
  const b = (st && st.boundaries) || {}
  const scopes = resolveScopes(cfg)
  const rc = cfg && cfg.permissions ? cfg.permissions.runCommands : undefined
  // 旧的 true / 'full' 一律落到最窄的 playground：删掉 full 不等于放开。
  const norm = (v) => {
    if (v === false || v === 'off' || v === undefined || v === null) return 'off'
    if (v === true || v === 'full') return 'playground'
    const name = String(v)
    return scopes[name] ? name : 'off'
  }
  // 失败关闭（2026-11-16）：配置里没写 = 没有这项能力。别人拿到插件时不会意外拿到权限。
  const execDefault = norm(rc === undefined ? 'off' : rc)
  const motionDefault = !!(cfg && cfg.permissions && cfg.permissions.desktopControl === true)
  // 社交三态：off=一律拒；owner=只放行发给用户的私聊；all=全放。
  // 默认 owner——摸鱼时用户不在电脑前，没法点批准，一律拒会把想说的话卡死。
  const socialDefault = (cfg && cfg.permissions && cfg.permissions.social) || 'owner'
  let execName = b.exec !== undefined ? norm(b.exec) : execDefault
  let net = typeof b.net === 'boolean' ? b.net : !!(cfg && cfg.permissions && cfg.permissions.networkReadonly === true)
  let social = typeof b.social === 'string' ? b.social : socialDefault

  // 包含关系（2026-11-16 用户提的规矩）：能力互相包含时，被包含的那个不许单独「宣称关着」。
  //
  //   跑 ⊃ 联：能跑 node/python 就等于能出网（node -e "fetch(...)"）。
  //            所以「联」关掉时，「跑」必须一起关——否则开关是假的。
  //   联 ⊃ 社交：发消息要先出网（走本机 3110 → SnowLuma → 腾讯）。
  //            所以「联」关掉时，社交一律 off。
  //
  // 反向不做自动纠正：开了「跑」不会偷偷把「联」改成开，只会在设置页标明
  // 「跑开着，联必然是开的」——不假装能关。
  if (!net) {
    execName = 'off'
    social = 'off'
  }

  let motion = typeof b.motion === 'boolean' ? b.motion : motionDefault

  // 严格档叠加：只往严的方向改，从来不放松。
  //   level >= 2 等于两把锁同时挂上；hands/outbound 可以单独挂。
  const strict = strictOf(cfg)
  const lockHands = strict.hands || strict.level >= 2
  const lockOutbound = strict.outbound || strict.level >= 2
  if (lockHands) {
    execName = 'off'
    motion = false
  }
  if (lockOutbound) {
    net = false
    social = 'off'
  }

  return {
    exec: execName === 'off' ? false : execName,
    execName,
    scope: execName === 'off' ? null : scopes[execName],
    scopes,
    net,
    motion,
    social,
    strict,
    lockHands,
    lockOutbound,
  }
}

// 摸鱼期间永久禁的工具（2026-11-16 用户定，L1 第 ④ 条）：
//   plugin_manager —— 能卸掉守卫本身；subagent / workflow —— 能另起一个执行体绕开守卫。
// 这三个跟「跑」「联」「社交」都不共享开关，任何时候都不给。
// 白名单（L1 第 ① 条，2026-11-16 用户定）：没登记的一律拒，不靠「我知道哪些危险」。
// 名单在这儿写死一部分，用户可以用 config 的 allow.extraTools 加；
// 摸鱼中要临时放行，写 ~/.dsh/moyu/freetime/allow-extra.json（数组），那个文件摸鱼时可写。
export const ALLOW_EXACT = new Set([
  // 文件（写的内容由 WRITE_SCOPE 与 readDenied 再管一层）
  'read', 'grep', 'glob', 'ops_read_files', 'write', 'edit',
  // 干活用的无害件
  'working_directory', 'todo_write', 'ask_user_question',
  'memory_read', 'memory_search', 'memory_append', 'soul_read',
  'schedule_list', 'schedule_view',
  // 上下文管理（不碰文件也不出网）
  'compress', 'decompress', 'acp_status', 'acp_cache', 'present', 'read_image',
  // 出网的（再由「联」判一次）
  'web_fetch', 'web_search',
  // 自己的工具（各自还有闸）
  'moyu_run', 'moyu_fetch', 'moyu_desktop', 'moyu_boundary', 'moyu_exit', 'moyu_web',
])
export const ALLOW_PREFIX = [
  // QQ：只读与会话管理；发消息这几类放行到「社交」那一层再判
  'mcp__snowluma__qq_get_', 'mcp__snowluma__qq_list_', 'mcp__snowluma__qq_status',
  'mcp__snowluma__qq_wait_for_messages', 'mcp__snowluma__qq_mark_read',
  'mcp__snowluma__qq_social_state', 'mcp__snowluma__qq_memory_',
  'mcp__snowluma__qq_slang_', 'mcp__snowluma__qq_collect_sticker',
  'mcp__snowluma__qq_sticker_note', 'mcp__snowluma__qq_report_feedback',
  'mcp__snowluma__qq_close_conversation', 'mcp__snowluma__qq_set_wake_config',
  'mcp__snowluma__qq_send', 'mcp__snowluma__qq_reply',
]

let ALLOW_EXTRA_CACHE = { at: 0, list: [] }
export function readAllowExtra(cfg) {
  const now = Date.now()
  if (now - ALLOW_EXTRA_CACHE.at < 5000) return ALLOW_EXTRA_CACHE.list
  const out = []
  const cfgList = (cfg && cfg.allow && Array.isArray(cfg.allow.extraTools)) ? cfg.allow.extraTools : []
  for (const x of cfgList) if (typeof x === 'string' && x) out.push(x)
  try {
    const p2 = path.join(MOYU_DIR, 'freetime', 'allow-extra.json')
    const arr = JSON.parse(fs.readFileSync(p2, 'utf8'))
    if (Array.isArray(arr)) for (const x of arr) if (typeof x === 'string' && x) out.push(x)
  } catch (err) {}
  ALLOW_EXTRA_CACHE = { at: now, list: out }
  return out
}

export function allowedTool(name, cfg) {
  if (ALLOW_EXACT.has(name)) return true
  for (const p2 of ALLOW_PREFIX) if (name.indexOf(p2) === 0) return true
  return readAllowExtra(cfg).indexOf(name) >= 0
}

export const MOYU_BAN = new Set(['plugin_manager', 'subagent', 'subagent_fork', 'workflow'])
export const MOYU_BAN_REASON = {
  plugin_manager: '装/卸插件会动守卫本身，退出摸鱼再说。',
  subagent: '另起一个执行体等于绕开边界，退出摸鱼再说。',
  subagent_fork: '另起一个执行体等于绕开边界，退出摸鱼再说。',
  workflow: '并行子代理等于绕开边界，退出摸鱼再说。',
}

// 边界快照（L1 第 ③ 条）：进摸鱼时记下 boundaries 与地盘的指纹，每次工具调用比对一次。
// 被人从外面改了 → 立刻退出摸鱼并写报告，不假装没发生。
export function stampOf(obj) {
  try {
    return JSON.stringify(obj, Object.keys(obj || {}).sort())
  } catch (err) {
    return ''
  }
}

export function boundaryFingerprint(b) {
  const o = b || {}
  return [String(o.exec), String(o.net), String(o.motion), String(o.social)].join('|')
}

export function scopeFingerprint(cfg) {
  const scopes = resolveScopes(cfg)
  const parts = Object.keys(scopes).sort().map((k) => {
    const sc = scopes[k]
    return k + ':' + sc.write.join(',') + '|' + sc.run.join(',') + '|' + (sc.runPaths || []).join(',') + '|' + (sc.net ? 1 : 0) + '|' + sc.timeoutMs
  })
  const perm = (cfg && cfg.permissions) || {}
  return parts.join(';') + '#' + String(perm.runCommands) + ',' + String(perm.networkReadonly) + ',' + String(perm.social)
}

export function appendTamper(event, why) {
  try {
    const dir = path.join(MOYU_DIR, 'freetime')
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(path.join(dir, 'tamper.log'), JSON.stringify({ ts: new Date().toISOString(), why, event }) + '\n', 'utf8')
  } catch (err) {}
}

export function toolPaths(args) {
  const out = []
  const push = (v) => { if (typeof v === 'string' && v) out.push(v) }
  push(args && args.path); push(args && args.file_path); push(args && args.dir); push(args && args.target)
  if (args && Array.isArray(args.files)) for (const f of args.files) push(f && f.path)
  return out.map((p) => { try { return path.resolve(p) } catch (e) { return p } })
}

// 先规范化再比：不然 "AkPlay\..\..\桌面\x.txt" 这种「前缀看着对、其实绕出去」的路径会被放行。
export function underRoot(p, roots) {
  const norm = (x) => {
    try { return path.resolve(String(x)).toLowerCase().replace(/[\\/]+$/, '') } catch (e) { return String(x).toLowerCase() }
  }
  const np = norm(p)
  return roots.some((r) => {
    const nr = norm(r)
    if (!nr) return false
    return np === nr || np.indexOf(nr + '\\') === 0 || np.indexOf(nr + '/') === 0
  })
}

// 同样的规范化：读名单也得挡住 "qq-console.json\..\..\别的" 这种绕法。
export function readDeniedHit(p, cfg) {
  const list = (cfg && cfg.paths && cfg.paths.readDenied) || []
  const norm = (x) => {
    try { return path.resolve(String(x)).toLowerCase().replace(/[\\/]+$/, '') } catch (e) { return String(x).toLowerCase() }
  }
  const np = norm(p)
  return list.some((r) => {
    const nr = norm(r)
    if (!nr) return false
    return np === nr || np.indexOf(nr + '\\') === 0 || np.indexOf(nr + '/') === 0
  })
}

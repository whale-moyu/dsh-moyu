// 把 ~/.dsh/moyu 的「程序部分」同步进插件包，让它自带 runtime。
// 用法：node make-runtime-bundle.mjs [源目录] [目标目录]
import { cpSync, mkdirSync, readdirSync, statSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const SRC = process.argv[2] || path.join(os.homedir(), '.dsh', 'moyu')
const DST = process.argv[3] || path.join(os.homedir(), 'Documents', 'dsh-moyu-repo', 'packages', 'dsh-moyu-badge', 'runtime', 'moyu')

// 用户数据，不进包
const SKIP_DIRS = new Set(['freetime', 'state', 'logs', 'secrets', 'bin', 'dist', 'old', '__pycache__', 'shots', '备档', 'games'])
const BIG_EXT = /\.(mp4|mkv|webm|mov|png|jpe?g|webp|gif|zip|7z|rar|exe|msi|pth|index|onnx|safetensors|silk|amr|wav|mp3)$/i
const SKIP_FILES = new Set([
  'config.json', 'state.json', 'grant.json', 'state.lastok.json', 'config.lastok.json', 'acl.json',
  // 本机私货：任务台账、待办、授权记录、临时日志、机器相关配置
  'TASKS.md', 'TODO.md', 'SAY-LATER.md', 'verify-log.md', '插件全貌.md', '踩坑与教训.md',
  '今晚授权-2026-11-14.txt', '2026-11-13-moyu.md',
  'play-log.jsonl', 'play-state.json', 'grid-calib.json', 'cursor-req.json', 'quota-state.json',
  'l3-programs.json', 'node-path.txt',
])

let copied = 0
let skipped = 0

function walk(from, to) {
  mkdirSync(to, { recursive: true })
  for (const name of readdirSync(from)) {
    const s = path.join(from, name)
    const d = path.join(to, name)
    const st = statSync(s)
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) { skipped++; continue }
      walk(s, d)
      continue
    }
    if (SKIP_FILES.has(name)) { skipped++; continue }
    if (/\.bak|\.broken|\.off|\.log$/i.test(name)) { skipped++; continue }
    if (BIG_EXT.test(name) || st.size > 3 * 1024 * 1024) { skipped++; continue }
    cpSync(s, d)
    copied++
  }
}

if (existsSync(DST)) rmSync(DST, { recursive: true, force: true })
walk(SRC, DST)

// 版本号：跟插件 package.json 一致
const pkgPath = path.join(path.dirname(DST), '..', 'package.json')
let version = '0.0.0'
try {
  version = JSON.parse(readFileSync(pkgPath, 'utf8').replace(/^\uFEFF/, '')).version
} catch {}
writeFileSync(path.join(DST, 'VERSION'), version + '\n', 'utf8')

// 配置模板：把用户专属的东西中性化
let cfg = {}
try { cfg = JSON.parse(readFileSync(path.join(SRC, 'config.json'), 'utf8').replace(/^\uFEFF/, '')) } catch {}
cfg.notebook = ''
if (cfg.scopes && typeof cfg.scopes === 'object') {
  for (const sc of Object.values(cfg.scopes)) {
    if (Array.isArray(sc.write)) sc.write = sc.write.map((w) => (/^[A-Za-z]:[\\/]/.test(w) ? w.replace(/^[A-Za-z]:[\\/]Users[\\/][^\\/]+/i, '~') : w))
  }
}
writeFileSync(path.join(DST, 'config.default.json'), JSON.stringify(cfg, null, 2) + '\n', 'utf8')

console.log(`copied=${copied} skipped=${skipped} version=${version}`)
console.log(`-> ${DST}`)

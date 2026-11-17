// 让插件自带 runtime：首次加载（或升级后）把包里的 runtime/moyu 铺到 %USERPROFILE%\.dsh\moyu\。
// 只铺程序文件；config.json / state.json / freetime / logs / secrets / bin / dist 这些用户数据一概不碰。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

// 用户数据：绝不覆盖
const USER_DIRS = new Set(['freetime', 'state', 'logs', 'secrets', 'bin', 'dist', 'shots', '备档', 'games'])
const USER_FILES = new Set([
  'config.json', 'state.json', 'grant.json', 'state.lastok.json', 'config.lastok.json', 'acl.json',
  'play-log.jsonl', 'play-state.json', 'quota-state.json', 'grid-calib.json', 'cursor-req.json',
  'l3-programs.json', 'node-path.txt',
])

function sha(p) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
  } catch {
    return ''
  }
}

function copyTree(src, dst, out) {
  fs.mkdirSync(dst, { recursive: true })
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name)
    const d = path.join(dst, name)
    const st = fs.statSync(s)
    if (st.isDirectory()) {
      if (USER_DIRS.has(name)) continue
      copyTree(s, d, out)
      continue
    }
    if (USER_FILES.has(name)) continue
    if (/\.bak|\.broken|\.off|\.log$/i.test(name)) continue
    const same = fs.existsSync(d) && fs.statSync(d).size === st.size && sha(s) === sha(d)
    if (same) continue
    fs.copyFileSync(s, d)
    out.copied++
  }
}

/**
 * @param {{pluginDir: string, moyuDir: string}} opts
 * @returns {{ok: boolean, reason?: string, bundledVersion?: string, installedVersion?: string, copied?: number}}
 */
export function ensureRuntime({ pluginDir, moyuDir }) {
  const src = path.join(pluginDir, 'runtime', 'moyu')
  if (!fs.existsSync(src)) return { ok: false, reason: 'no-bundle' }

  let bundledVersion = ''
  try {
    bundledVersion = fs.readFileSync(path.join(src, 'VERSION'), 'utf8').trim()
  } catch {
    return { ok: false, reason: 'bundle-without-version' }
  }

  const vFile = path.join(moyuDir, 'VERSION')
  let installedVersion = ''
  try {
    installedVersion = fs.readFileSync(vFile, 'utf8').trim()
  } catch {}

  const out = { copied: 0 }
  try {
    copyTree(src, moyuDir, out)
    // 首次安装：给一份配置模板
    const cfg = path.join(moyuDir, 'config.json')
    if (!fs.existsSync(cfg)) {
      const tpl = path.join(src, 'config.default.json')
      if (fs.existsSync(tpl)) {
        fs.copyFileSync(tpl, cfg)
        out.copied++
      }
    }
    fs.writeFileSync(vFile, bundledVersion + '\n', 'utf8')
  } catch (e) {
    return { ok: false, reason: 'copy-failed: ' + (e && e.message), bundledVersion, installedVersion, copied: out.copied }
  }

  return { ok: true, bundledVersion, installedVersion, copied: out.copied }
}

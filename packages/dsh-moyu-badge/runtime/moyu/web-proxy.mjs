// web-proxy.mjs —— AI 浏览器的出网闸门（只放公网，挡本机与内网）
// 【称呼对照】本机有两个受限账号，名字是英文，意思在这里：
//   moyu  = 摸鱼账号：能写 playground 与 freetime，不出网；摸鱼时跑小程序用它。
//   akweb = 浏览器账号：能上网，碰不到用户目录；AI 浏览器以它的身份运行。
// 为什么需要它：Windows 防火墙不过滤回环流量，127.0.0.1 拦不住；只能让浏览器把所有请求
// 先交给这个代理，由它按解析后的真实 IP 判断。
// 起法：node web-proxy.mjs   （127.0.0.1:9334）
import http from 'node:http'
import net from 'node:net'
import dns from 'node:dns/promises'
import fs from 'node:fs'
import path from 'node:path'

const PORT = 9334
const LOG = path.join(process.env.USERPROFILE, '.dsh', 'moyu', 'freetime', 'web-access.log')
const ALLOW_PORTS = new Set([80, 443])

function isPrivate(ip) {
  if (ip.includes(':')) {
    const s = ip.toLowerCase()
    if (s === '::1' || s === '::') return true
    if (s.startsWith('fe80') || s.startsWith('fc') || s.startsWith('fd')) return true
    if (s.startsWith('::ffff:')) return isPrivate(s.slice(7))
    return false
  }
  const p = ip.split('.').map(Number)
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true
  if (p[0] === 127 || p[0] === 0 || p[0] === 10) return true
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true
  if (p[0] === 192 && p[1] === 168) return true
  if (p[0] === 169 && p[1] === 254) return true
  if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true
  return false
}

function log(line) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true })
    fs.appendFileSync(LOG, new Date().toISOString() + ' ' + line + '\n')
  } catch {}
}

async function allowed(host, port) {
  if (!ALLOW_PORTS.has(port)) { log(`DENY port ${host}:${port}`); return '端口不让走（只放 80 / 443）' }
  let ips = []
  try { ips = await dns.lookup(host, { all: true }) } catch (e) { log(`FAIL dns ${host}`); return '域名解析不了' }
  for (const { address } of ips) {
    if (isPrivate(address)) { log(`DENY private ${host} -> ${address}`); return `目标是本机/内网（${address}）` }
  }
  log(`ALLOW ${host}:${port} -> ${ips.map((x) => x.address).join(',')}`)
  return null
}

const startedAt = Date.now()

const server = http.createServer((req, res) => {
  // 健康检查：web-cdp.mjs health 用它判断闸门还在不在
  if (req.url === '/__health') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: true, pid: process.pid, upSec: Math.round((Date.now() - startedAt) / 1000), allowPorts: [...ALLOW_PORTS] }))
    return
  }
  // 普通 http 代理：req.url 是绝对地址
  let u
  try { u = new URL(req.url) } catch { res.writeHead(400).end('bad url'); return }
  const port = Number(u.port || 80)
  allowed(u.hostname, port).then((deny) => {
    if (deny) { res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('被闸门拦下：' + deny); return }
    const up = http.request(
      { host: u.hostname, port, method: req.method, path: u.pathname + u.search, headers: req.headers },
      (r) => { res.writeHead(r.statusCode || 502, r.headers); r.pipe(res) },
    )
    up.on('error', (e) => { log(`ERR ${u.hostname} ${e.message}`); res.writeHead(502).end('upstream error') })
    req.pipe(up)
  })
})

server.on('connect', (req, socket, head) => {
  const [host, portStr] = req.url.split(':')
  const port = Number(portStr || 443)
  allowed(host, port).then((deny) => {
    if (deny) {
      socket.write(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain; charset=utf-8\r\n\r\n被闸门拦下：${deny}`)
      socket.destroy()
      return
    }
    const up = net.connect(port, host, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head && head.length) up.write(head)
      up.pipe(socket); socket.pipe(up)
    })
    up.on('error', () => socket.destroy())
    socket.on('error', () => up.destroy())
  })
})

server.listen(PORT, '127.0.0.1', () => console.log(`web-proxy on 127.0.0.1:${PORT}  log=${LOG}`))

// ---- 只在摸鱼期间活着 ----
// 退出摸鱼有几条路（设置页的「退出摸鱼」、moyu.ps1 exit、moyu_exit 工具），
// 前两条会主动收我，第三条只切 mode 再杀掉守夜人。与其每条路都改一遍，
// 不如我自己盯着 state.json：mode 不是 moyu 就收掉浏览器、然后退出。
const MOYU_ROOT = path.dirname(new URL(import.meta.url).pathname.slice(1).replace(/^\/([A-Za-z]:)/, '$1'))
const STATE = path.join(MOYU_ROOT, 'state.json')
const childPromise = import('node:child_process')

function killBrowser() {
  const ps = "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -like '*AkWebProfile*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
  return childPromise.then(({ execFileSync }) => {
    try { execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { timeout: 20000, windowsHide: true }) } catch {}
  })
}

// 调试用：MOYU_WEB_KEEP=1 时不管 mode，方便在代码模式里测东西（不会进打包流程）
const KEEP = process.env.MOYU_WEB_KEEP === '1'
setInterval(() => {
  if (KEEP) return
  let mode = ''
  try { mode = JSON.parse(fs.readFileSync(STATE, 'utf8')).mode || '' } catch { mode = '' }
  if (mode && mode !== 'moyu') {
    killBrowser().then(() => {
      console.log('web-proxy exit: 摸鱼已结束，收掉浏览器和代理')
      process.exit(0)
    })
  }
}, 15000).unref()
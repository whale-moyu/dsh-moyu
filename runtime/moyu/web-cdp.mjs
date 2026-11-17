// web-cdp.mjs —— 通过调试端口跟我们那台 AI 浏览器说话
// 【称呼对照】本机有两个受限账号，名字是英文，意思在这里：
//   moyu  = 摸鱼账号：能写 playground 与 freetime，不出网；摸鱼时跑小程序用它。
//   akweb = 浏览器账号：能上网，碰不到用户目录；AI 浏览器以它的身份运行。
//
// 用法（所有命令都支持 --tab N 选第 N 个页签，默认 0）：
//   node web-cdp.mjs list                     看有哪些页签
//   node web-cdp.mjs health                   代理和调试端口通不通
//   node web-cdp.mjs nav <url>                打开网址，等加载完
//   node web-cdp.mjs text [--max 4000]        取正文（去掉导航/脚本/页脚）
//   node web-cdp.mjs title                    标题 | 地址
//   node web-cdp.mjs click <选择器>           点
//   node web-cdp.mjs type <选择器> <文字>     输入（逐个字符，带 input 事件）
//   node web-cdp.mjs press <选择器|body> <键> 按键，如 Enter / Escape / Tab
//   node web-cdp.mjs scroll <top|bottom|+300|-300>
//   node web-cdp.mjs wait <选择器|毫秒>
//   node web-cdp.mjs eval <js>                在页面里执行（返回 JSON）
//   node web-cdp.mjs shot <out.png> [--full]  截图
//   node web-cdp.mjs usage                    今天访问了多少站
const PORT = 9333
const BASE = `http://127.0.0.1:${PORT}`
const fs = await import('node:fs')
const path = await import('node:path')
const os = await import('node:os')

const HOME = os.homedir()
const MOYU = path.join(HOME, '.dsh', 'moyu')
const FREETIME = path.join(MOYU, 'freetime')
const USAGE = path.join(FREETIME, 'web-usage.json')
const INBOX = 'C:\\Users\\akweb\\Downloads\\ak-inbox'

const argv = process.argv.slice(2)
const cmd = argv[0]
const flags = {}
const args = []
for (let i = 1; i < argv.length; i++) {
  const a = argv[i]
  if (a.startsWith('--')) {
    const k = a.slice(2)
    const nx = argv[i + 1]
    if (nx && !nx.startsWith('--')) { flags[k] = nx; i++ } else flags[k] = true
  } else args.push(a)
}

async function listTabs() {
  const r = await fetch(`${BASE}/json/list`)
  const all = await r.json()
  return all.filter((t) => t.type === 'page')
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    let id = 0
    const pending = new Map()
    const subs = new Map()
    ws.addEventListener('open', () => resolve({ send, on, close: () => ws.close() }))
    ws.addEventListener('error', () => reject(new Error('ws error')))
    ws.addEventListener('message', (ev) => {
      let msg
      try { msg = JSON.parse(ev.data) } catch { return }
      if (msg.method) {
        const fns = subs.get(msg.method)
        if (fns) for (const f of fns) { try { f(msg.params) } catch (e) {} }
        return
      }
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id)
        pending.delete(msg.id)
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result)
      }
    })
    function on(method, fn) {
      if (!subs.has(method)) subs.set(method, [])
      subs.get(method).push(fn)
      return () => { const a = subs.get(method) || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1) }
    }
    function send(method, params = {}) {
      return new Promise((res, rej) => {
        const myId = ++id
        pending.set(myId, { res, rej })
        ws.send(JSON.stringify({ id: myId, method, params }))
        setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); rej(new Error('timeout ' + method)) } }, 20000)
      })
    }
  })
}

// 浏览器是 --incognito 起的：页面跑在 OTR（隐身）上下文里。
// Browser.setDownloadBehavior 不带 browserContextId 只作用于「默认上下文」，
// 隐身上下文里那条根本不生效 —— 这就是「机制和日志都写了、一次没落盘」的真因。
// 另外 Browser.download* 事件只在浏览器级连接上收得到，页面级连接收不到。
async function browserConn() {
  const r = await fetch(`${BASE}/json/version`)
  const v = await r.json()
  return connect(v.webSocketDebuggerUrl)
}

function downloadLog(line) {
  try {
    fs.appendFileSync(path.join(FREETIME, 'web-downloads.log'), new Date().toISOString() + ' ' + line + '\n')
  } catch (e) {}
}

let browser = null
async function setupBrowserInbox(tab) {
  try {
    const b = await browserConn()
    browser = b
    const tg = await b.send('Target.getTargets')
    const info = (tg.targetInfos || []).find((x) => x.targetId === tab.id)
    const ctxId = info && info.browserContextId
    const params = { behavior: 'allow', downloadPath: INBOX, eventsEnabled: true }
    if (ctxId) params.browserContextId = ctxId
    await b.send('Browser.setDownloadBehavior', params)
    b.on('Browser.downloadWillBegin', (p) => downloadLog('BEGIN ' + (p.suggestedFilename || '?') + ' <- ' + (p.url || '')))
    b.on('Browser.downloadProgress', (p) => { if (p && p.state === 'completed') downloadLog('DONE  ' + (p.guid || '')) })
    return ctxId || '(default)'
  } catch (e) {
    downloadLog('setup failed: ' + e.message)
    return 'fail: ' + e.message
  }
}

// 上传：掐文件选择框只能挡「点按钮选文件」。页面自己拼 multipart 再发，就绕过去了。
// 这里在 Fetch 层把带 multipart 的非 GET 请求直接掐掉。
async function setupUploadGuard(c) {
  const log = (line) => {
    try {
      fs.appendFileSync(path.join(FREETIME, 'web-uploads.log'), new Date().toISOString() + ' ' + line + '\n')
    } catch (e) {}
  }
  try {
    await c.send('Fetch.enable', {
      patterns: [
        { urlPattern: '*', resourceType: 'XHR', requestStage: 'Request' },
        { urlPattern: '*', resourceType: 'Fetch', requestStage: 'Request' },
      ],
    })
    c.on('Fetch.requestPaused', async (p) => {
      const req = p.request || {}
      const method = String(req.method || 'GET').toUpperCase()
      const h = req.headers || {}
      const ct = String(h['Content-Type'] || h['content-type'] || '')
      const isUpload = method !== 'GET' && /multipart\/form-data/i.test(ct)
      try {
        if (isUpload) {
          log('BLOCK ' + method + ' ' + (req.url || ''))
          await c.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' })
        } else {
          await c.send('Fetch.continueRequest', { requestId: p.requestId })
        }
      } catch (e) {}
    })
    return true
  } catch (e) {
    log('guard failed: ' + e.message)
    return false
  }
}

async function health() {
  const out = []
  try {
    const r = await fetch(`http://127.0.0.1:9334/__health`, { method: 'GET' })
    out.push(`代理 9334：${r.status === 404 || r.status === 200 ? '在' : '状态 ' + r.status}`)
  } catch (e) {
    out.push('代理 9334：**不通**（浏览器现在什么都打不开）')
  }
  try {
    const r = await fetch(`${BASE}/json/version`)
    const v = await r.json()
    out.push(`调试端口 9333：在（${v.Browser || 'Edge'}）`)
  } catch {
    out.push('调试端口 9333：不通（浏览器没起，先跑 run-web.ps1）')
  }
  out.push(`下载投递箱：${INBOX}`)
  return out.join('\n')
}

// 配额：一天最多上多少个站。web-quota.json 可改 {"dailyMax": 120}；没有就用默认值。
// 浏览器的两道临时锁（用户 2026-11-16 定）：开关在设置页，值落在 config.json 的 web.*。
// blockLocalFiles 由 web-locks.ps1 改注册表实现；blockRawUpload 在这里注入页面级 shim。
const CONFIG = path.join(MOYU, 'config.json')
function webCfg() {
  // 2026-11-17：默认开。以前配置里没写就是「不拦」，而这道锁的本意是「默认不让人往外送文件」。
  const fallback = { blockRawUpload: true, blockLocalFiles: true }
  try {
    const raw = fs.readFileSync(CONFIG, 'utf8').replace(/^\uFEFF/, '')
    const w = JSON.parse(raw).web || {}
    return {
      blockRawUpload: w.blockRawUpload === undefined ? true : !!w.blockRawUpload,
      blockLocalFiles: w.blockLocalFiles === undefined ? true : !!w.blockLocalFiles,
    }
  } catch { return fallback }
}

const RAW_UPLOAD_SHIM = `(() => {
  const MAX = 32768
  const looksLikeFile = (body, type) => {
    if (body == null) return false
    const t = String(type || '').toLowerCase()
    if (t.includes('application/octet-stream')) return true
    if (typeof body === 'string') return body.length > MAX
    if (body instanceof Blob) return body.size > 4096
    if (body instanceof ArrayBuffer) return body.byteLength > MAX
    if (ArrayBuffer.isView(body)) return body.byteLength > MAX
    return false
  }
  if (navigator.sendBeacon) {
    const origBeacon = navigator.sendBeacon.bind(navigator)
    navigator.sendBeacon = function (url, data) {
      try {
        if (data instanceof Blob || (typeof data === 'string' && data.length > 32768)) {
          console.warn('moyu: 拦下了 sendBeacon（blockRawUpload 开着）')
          return false
        }
      } catch (e) {}
      return origBeacon(url, data)
    }
  }
  const origFetch = window.fetch
  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || ''
      const body = init && init.body
      const type = (init && init.headers && (init.headers['content-type'] || init.headers['Content-Type'])) || ''
      if (looksLikeFile(body, type)) {
        return Promise.reject(new Error('moyu: 拦下了疑似文件内容的上传（blockRawUpload 开着）'))
      }
      return origFetch.apply(this, arguments)
    } catch (e) { return origFetch.apply(this, arguments) }
  }
  const origSend = XMLHttpRequest.prototype.send
  XMLHttpRequest.prototype.send = function (body) {
    try {
      const type = this.getRequestHeader && this.getRequestHeader('content-type')
      if (looksLikeFile(body, type)) throw new Error('moyu: 拦下了疑似文件内容的上传（blockRawUpload 开着）')
      return origSend.apply(this, arguments)
    } catch (e) { throw e }
  }
})()`

const QUOTA = path.join(FREETIME, 'web-quota.json')
function dailyMax() {
  try { const q = JSON.parse(fs.readFileSync(QUOTA, 'utf8')); if (q && q.dailyMax > 0) return q.dailyMax } catch {}
  return 120
}
function todayCount() {
  try {
    const u = JSON.parse(fs.readFileSync(USAGE, 'utf8'))
    return u.day === new Date().toISOString().slice(0, 10) ? u.count : 0
  } catch { return 0 }
}

function bumpUsage(url) {
  let u = { day: '', count: 0, urls: [] }
  try { u = JSON.parse(fs.readFileSync(USAGE, 'utf8')) } catch {}
  const today = new Date().toISOString().slice(0, 10)
  if (u.day !== today) u = { day: today, count: 0, urls: [] }
  u.count++
  u.urls.push({ t: new Date().toISOString(), u: url })
  if (u.urls.length > 500) u.urls = u.urls.slice(-500)
  fs.mkdirSync(FREETIME, { recursive: true })
  fs.writeFileSync(USAGE, JSON.stringify(u, null, 1))
  return u.count
}

const EXTRACT = `(function(){
  const bad = 'script,style,noscript,svg,iframe,nav,header,footer,aside,form,button,[aria-hidden="true"]';
  // 候选里挑「正文最多」的那个，而不是第一个命中的：必应首页的 #content 只有几行，
  // 取第一个会把整页读成「国内版国际版」。短于 300 字就退回 body。
  const cands = Array.from(document.querySelectorAll('article,main,[role=main],#content,.article,.post,.content'));
  let pick = null, best = -1;
  for (const el of cands) { const len = (el.innerText || '').length; if (len > best) { best = len; pick = el; } }
  if (!pick || best < 300) pick = document.body;
  if (!pick) return '';
  const clone = pick.cloneNode(true);
  clone.querySelectorAll(bad).forEach(function(n){ n.remove(); });
  const lines = (clone.innerText || '').split('\\n').map(function(s){ return s.trim(); });
  const kept = [];
  for (const s of lines) { if (!s) continue; if (kept.length && kept[kept.length-1] === s) continue; kept.push(s); }
  return kept.join('\\n');
})()`

let tabs = []
try { tabs = await listTabs() } catch (e) { tabs = [] }
if (cmd === 'health') { console.log(await health()); process.exit(0) }
if (cmd === 'usage') {
  try { const u = JSON.parse(fs.readFileSync(USAGE, 'utf8')); console.log(`${u.day}：${u.count} 次`) } catch { console.log('今天还没访问过') }
  process.exit(0)
}
if (!tabs.length) { console.error('没有页签，先起浏览器（run-web.ps1）'); process.exit(2) }
const tabIdx = Number(flags.tab || 0)
const tab = tabs[tabIdx] || tabs[0]
const c = await connect(tab.webSocketDebuggerUrl)
// 挡上传第二层：页面自己拼 multipart 也发不出去。所有命令都开，不只 nav。
await setupUploadGuard(c)

async function evaluate(expression) {
  const r = await c.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || ''))
  return r.result ? r.result.value : undefined
}

async function waitLoad(timeout = 15000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    try { if (await evaluate('document.readyState') === 'complete') { await new Promise((r) => setTimeout(r, 400)); return true } } catch {}
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
}

try {
  if (cmd === 'list') {
    tabs.forEach((t, i) => console.log(`${i}. ${t.title} :: ${t.url}`))
  } else if (cmd === 'nav') {
    const url = args[0]
    if (!url) throw new Error('要一个网址')
    if (/^\s*file:/i.test(url)) {
      console.error('不打开本地文件（file://）：这台浏览器只用来上外网，本地文件我直接用 read 读。')
      process.exit(3)
    }
    const cap = dailyMax()
    const used = todayCount()
    if (used >= cap) {
      console.error(`今天已经上了 ${used} 个站，到配额了（上限 ${cap}，改 ${QUOTA} 里的 dailyMax 可以放宽）。`)
      process.exit(4)
    }
    await c.send('Page.enable')
    // 挡上传第二层（可选，设置页开关）：页面自己拼 body 发出去也拦。
    // 页面级 shim，绕过它不难——所以它是「减速带」，不是「墙」；真墙要等以后有更好的办法。
    if (webCfg().blockRawUpload) {
      await c.send('Page.addScriptToEvaluateOnNewDocument', { source: RAW_UPLOAD_SHIM }).catch(() => {})
      await evaluate(RAW_UPLOAD_SHIM).catch(() => {})
    }
    // 挡上传第一层：文件选择框不弹，页面拿不到本地文件。
    await c.send('Page.setInterceptFileChooserDialog', { enabled: true }).catch(() => {})
    // 下载：投递箱设到页面所在的（隐身）上下文，事件走浏览器级连接。
    const dlCtx = await setupBrowserInbox(tab)
    // 上传拦截在连上页面后就开了（见 connect 之后那句），这里不用重复。
    let beforeHref = ''
    try { beforeHref = await evaluate('location.href') } catch {}
    await c.send('Page.navigate', { url })
    await waitLoad(Number(flags.wait || 15000))
    const n = bumpUsage(url)
    const info = await evaluate('document.title + " | " + location.href')
    console.log(info)
    console.log(`(今天第 ${n} 次访问；下载投递箱挂在上下文 ${dlCtx})`)
    try {
      const afterHref = await evaluate('location.href')
      if (beforeHref && afterHref === beforeHref) {
        console.log('（页面没跳：这条大概是下载链接，文件去投递箱看，日志在 freetime/web-downloads.log）')
      }
    } catch {}
  } else if (cmd === 'title') {
    console.log(await evaluate('document.title + " | " + location.href'))
  } else if (cmd === 'text') {
    const max = Number(flags.max || 4000)
    const s = await evaluate(EXTRACT)
    console.log((s || '(空)').slice(0, max))
  } else if (cmd === 'click') {
    const sel = args[0]
    if (!sel) throw new Error('要一个选择器')
    const before = await evaluate('location.href')
    const info = await evaluate(`(function(){
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return { status: 'not-found' };
      el.scrollIntoView({block:'center'});
      const r = el.getBoundingClientRect();
      const a = el.closest('a[href]');
      el.click();
      return { status: 'clicked ' + Math.round(r.width) + 'x' + Math.round(r.height),
               href: a ? a.href : '' };
    })()`)
    if (info.status === 'not-found') { console.log('没找到这个选择器'); process.exit(1) }
    console.log(info.status)
    await new Promise((r) => setTimeout(r, 1200))
    const after = await evaluate('location.href')
    if (after === before && info.href && info.href !== before) {
      // 点了没跳（常见于 target=_blank 被拦、或链接靠 JS 跳转）：直接按 href 走
      console.log('点了没跳，按链接地址直接进：' + info.href)
      await c.send('Page.navigate', { url: info.href })
      await waitLoad(Number(flags.wait || 15000))
    }
    console.log(await evaluate('document.title + " | " + location.href'))
  } else if (cmd === 'type') {
    const sel = args[0]
    const text = args.slice(1).join(' ')
    const ok = await evaluate(`(function(){
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return 'not-found';
      el.focus();
      const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(text)});
      el.dispatchEvent(new Event('input', {bubbles:true}));
      el.dispatchEvent(new Event('change', {bubbles:true}));
      return 'typed ' + el.value.length + ' chars';
    })()`)
    console.log(ok)
  } else if (cmd === 'press') {
    const sel = args[0] || 'body'
    const key = args[1] || 'Enter'
    const ok = await evaluate(`(function(){
      const el = document.querySelector(${JSON.stringify(sel)}) || document.body;
      el.focus();
      const map = {Enter:{key:'Enter',code:'Enter',keyCode:13,which:13},Escape:{key:'Escape',code:'Escape',keyCode:27,which:27},Tab:{key:'Tab',code:'Tab',keyCode:9,which:9}};
      const k = map[${JSON.stringify(key)}] || {key:${JSON.stringify(key)},code:${JSON.stringify(key)},keyCode:0,which:0};
      ['keydown','keyup'].forEach(function(t){ el.dispatchEvent(new KeyboardEvent(t, Object.assign({bubbles:true}, k))); });
      return 'pressed '+k.key;
    })()`)
    console.log(ok)
    await new Promise((r) => setTimeout(r, 800))
    console.log(await evaluate('document.title + " | " + location.href'))
  } else if (cmd === 'scroll') {
    const to = args[0] || 'bottom'
    const r = await evaluate(`(function(){
      const h = document.documentElement.scrollHeight;
      const t = ${JSON.stringify(to)};
      if (t === 'top') window.scrollTo(0,0);
      else if (t === 'bottom') window.scrollTo(0,h);
      else window.scrollBy(0, Number(t.replace('+','')) || 0);
      return Math.round(window.scrollY) + ' / ' + h;
    })()`)
    console.log(r)
  } else if (cmd === 'wait') {
    const what = args[0]
    if (/^\d+$/.test(what)) { await new Promise((r) => setTimeout(r, Number(what))); console.log('等了 ' + what + 'ms') }
    else {
      const t0 = Date.now()
      let found = false
      while (Date.now() - t0 < 20000) {
        if (await evaluate(`!!document.querySelector(${JSON.stringify(what)})`)) { found = true; break }
        await new Promise((r) => setTimeout(r, 250))
      }
      console.log(found ? '出现了：' + what : '20 秒没等到：' + what)
    }
  } else if (cmd === 'eval') {
    const js = args.join(' ')
    const v = await evaluate(js)
    console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 1))
  } else if (cmd === 'shot') {
    const out = args[0]
    const params = { format: 'png' }
    if (flags.full) params.captureBeyondViewport = true
    const r = await c.send('Page.captureScreenshot', params)
    fs.writeFileSync(out, Buffer.from(r.data, 'base64'))
    console.log('saved ' + out)
  } else {
    console.error('未知命令，看文件头部的用法')
    process.exit(2)
  }
} finally {
  try { c.close() } catch {}
  try { browser && browser.close() } catch {}
}

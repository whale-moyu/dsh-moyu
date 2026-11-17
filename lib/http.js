// HTTP 小工具：只读本机、统一拒绝、读 JSON 请求体、同源校验。
// 拆自 index.js（2026-11-17）。
import fs from 'node:fs'

export function isLoopback(req) {
  try {
    const host = String((req && req.headers && req.headers.host) || '')
    const u = new URL('http://' + host)
    const h = u.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
    if (h === 'localhost' || h.endsWith('.localhost')) return true
    if (h === '::1') return true
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
    return !!m && Number(m[1]) === 127
  } catch (err) {
    return false
  }
}

export function deny(res) {
  res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('forbidden')
}

// 2026-11-17：state.json 跟 config.json 同一个病（坏一个字符 → 整个摸鱼状态读不出来）。
//   改法和 config 一样：读不出来就回落到上一份 good 快照，并且留痕。

export function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 65536) { finish(null); try { req.destroy() } catch (e) {} }
    })
    req.on('end', () => {
      try { finish(JSON.parse(raw || '{}')) } catch (err) { finish(null) }
    })
    req.on('error', () => finish(null))
  })
}

// 这三个入口都只写状态/配置，不执行外部命令，所以只要挡住跨站请求就够了。
export function sameOrigin(req) {  const site = String((req && req.headers && req.headers['sec-fetch-site']) || '')
  return !site || site === 'same-origin' || site === 'none'
}

// 地盘（scope）：2026-11-16 用户定——「跑」不再有「全放」，只有关着，或者落在某块地盘里。
// 一块地盘 = 能写的目录 + 能起的程序 + 能不能出网 + 时限。
// 默认只带 playground 一块；新增地盘写 config.json 的 scopes，得用户点头。

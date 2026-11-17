/**
 * dsh-moyu-badge 的设置页（客户端）。
 *
 * 宿主用 __ModuleLoader__ 的工厂格式加载它：factory 收到的 require 能解析
 * 'react'（宿主模块表里的那一份），所以不需要打包 react，也不需要 JSX —
 * 全部用 React.createElement 手写，避免为了一个设置页引入构建链。
 *
 * 数据全走 lib/index.js 已有的路由：
 *   GET/POST /api/dsh-moyu/config  读/合并写 config.json
 *   GET      /api/dsh-moyu/doctor  跑 doctor.ps1 拿纯文本
 *   GET      /api/dsh-moyu/manual  读摸鱼手册.md
 *   GET      /api/dsh-moyu/enter   进入摸鱼（?budget=&minutes=）
 *   GET      /api/dsh-moyu/exit    退出摸鱼 + 停守夜人 + 撤安全锁
 */
window.__ModuleLoader__.load({
  id: 'dsh-moyu-badge',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    var React = require('react')
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect
    var useCallback = React.useCallback
    var useRef = React.useRef

    var NS = 'dsh-moyu'

    // ---- 样式（内联，不依赖宿主主题类名） ----
    var S = {
      wrap: { display: 'flex', flexDirection: 'column', gap: '0px', padding: '4px 0 40px' },
      card: { border: '1px solid rgba(127,127,127,.25)', borderRadius: '10px', padding: '18px 20px', marginBottom: '30px', scrollMarginTop: '58px' },
      h2: { margin: '0 0 10px', fontSize: '15px', fontWeight: 600 },
      h3: { margin: '0 0 8px', fontSize: '13px', fontWeight: 600, opacity: 0.85 },
      row: { display: 'flex', alignItems: 'center', gap: '10px', margin: '8px 0', flexWrap: 'wrap' },
      label: { minWidth: '132px', fontSize: '13px', opacity: 0.85 },
      input: { width: '92px', padding: '4px 8px', borderRadius: '6px', border: '1px solid rgba(127,127,127,.4)', background: 'transparent', color: 'inherit', fontSize: '13px' },
      btn: { padding: '5px 12px', borderRadius: '6px', border: '1px solid rgba(127,127,127,.45)', background: 'transparent', color: 'inherit', fontSize: '13px', cursor: 'pointer' },
      btnPrimary: { padding: '5px 14px', borderRadius: '6px', border: '1px solid rgba(64,132,255,.6)', background: 'rgba(64,132,255,.12)', color: 'inherit', fontSize: '13px', cursor: 'pointer' },
      btnDanger: { padding: '5px 14px', borderRadius: '6px', border: '1px solid rgba(220,80,80,.6)', background: 'rgba(220,80,80,.12)', color: 'inherit', fontSize: '13px', cursor: 'pointer' },
      muted: { fontSize: '12px', opacity: 0.62, lineHeight: 1.6 },
      pre: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'ui-monospace, Consolas, monospace', fontSize: '12px', lineHeight: 1.55, background: 'rgba(127,127,127,.09)', padding: '10px 12px', borderRadius: '8px', maxHeight: '360px', overflow: 'auto', margin: 0 },
      md: { fontSize: '14px', lineHeight: '1.78', fontFamily: 'system-ui, -apple-system, "Microsoft YaHei", "PingFang SC", sans-serif', background: 'rgba(127,127,127,.07)', padding: '14px 16px', borderRadius: '8px', maxHeight: '460px', overflow: 'auto', color: 'inherit' },
      mdH1: { fontSize: '17px', fontWeight: 700, margin: '4px 0 10px' },
      mdH2: { fontSize: '15px', fontWeight: 700, margin: '16px 0 8px' },
      mdP: { margin: '6px 0' },
      mdList: { margin: '6px 0 6px 18px', padding: 0 },
      mdTable: { borderCollapse: 'collapse', width: '100%', margin: '8px 0', fontSize: '13px' },
      mdTh: { textAlign: 'left', padding: '5px 8px', borderBottom: '1px solid rgba(127,127,127,.35)', fontWeight: 600 },
      mdTd: { padding: '5px 8px', borderBottom: '1px solid rgba(127,127,127,.18)' },
      mdHr: { border: 0, borderTop: '1px solid rgba(127,127,127,.25)', margin: '14px 0' },
      mdQuote: { borderLeft: '3px solid rgba(127,127,127,.35)', paddingLeft: '10px', opacity: .8, margin: '6px 0' },
      codeBlock: { whiteSpace: 'pre-wrap', fontFamily: 'ui-monospace, Consolas, monospace', fontSize: '12.5px', lineHeight: 1.6, background: 'rgba(127,127,127,.14)', padding: '10px 12px', borderRadius: '6px', overflow: 'auto', margin: '8px 0' },
      codeInline: { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: '0.92em', padding: '1px 4px', borderRadius: '4px', background: 'rgba(127,127,127,.16)' },
      pill: { display: 'inline-block', padding: '1px 8px', borderRadius: '999px', fontSize: '12px', border: '1px solid rgba(127,127,127,.4)' },
      ok: { color: '#2e9e5b' },
      warn: { color: '#d2553c', fontSize: '12px', lineHeight: '1.6' },
      bad: { color: '#d05050' },
      tabBar: { display: 'flex', flexWrap: 'wrap', gap: '4px', padding: '4px 2px 10px', borderBottom: '1px solid rgba(127,127,127,.22)' },
      tab: { padding: '5px 12px', borderRadius: '7px', border: '1px solid transparent', background: 'transparent', color: 'inherit', opacity: 0.68, fontSize: '13px', cursor: 'pointer' },
      sticky: { position: 'sticky', top: 0, zIndex: 6, display: 'flex', alignItems: 'baseline', gap: '8px', padding: '9px 2px', background: 'rgba(127,127,127,.10)', backdropFilter: 'blur(10px)', borderBottom: '1px solid rgba(127,127,127,.22)' },
      stickyTitle: { fontSize: '14px', fontWeight: 600, letterSpacing: '.2px' },
      sectionAnchor: { scrollMarginTop: '58px', height: 0 },
      tiles: { display: 'flex', flexWrap: 'wrap', gap: '10px', margin: '12px 0 6px' },
      tile: { flex: '1 1 210px', minWidth: '200px', border: '1px solid rgba(127,127,127,.28)', borderRadius: '10px', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '8px' },
      tileName: { fontSize: '13px', fontWeight: 600, letterSpacing: '.5px' },
      tileVal: { fontSize: '15px', fontWeight: 700 },
      tileHint: { fontSize: '12px', opacity: 0.6, lineHeight: 1.5 },
      select: { fontSize: '13px', padding: '4px 6px', borderRadius: '6px', border: '1px solid rgba(127,127,127,.4)', background: 'transparent', color: 'inherit', colorScheme: 'dark' },
      chips: { display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' },
      chip: { padding: '2px 9px', borderRadius: '999px', border: '1px solid rgba(127,127,127,.35)', background: 'transparent', color: 'inherit', opacity: 0.72, fontSize: '12px', cursor: 'pointer' },
      chipOn: { padding: '2px 9px', borderRadius: '999px', border: '1px solid rgba(64,132,255,.6)', background: 'rgba(64,132,255,.14)', color: 'inherit', opacity: 1, fontSize: '12px', cursor: 'pointer', fontWeight: 600 },
      tabOn: { padding: '5px 12px', borderRadius: '7px', border: '1px solid rgba(64,132,255,.55)', background: 'rgba(64,132,255,.12)', color: 'inherit', opacity: 1, fontSize: '13px', cursor: 'pointer', fontWeight: 600 },
    // 严格页用红：它是「往严里走」的开关，跟其它六页不是一类东西
    tabRed: { padding: '5px 12px', borderRadius: '7px', border: '1px solid rgba(217,83,79,.45)', background: 'transparent', color: '#e0726e', opacity: 0.85, fontSize: '13px', cursor: 'pointer' },
    tabOnRed: { padding: '5px 12px', borderRadius: '7px', border: '1px solid rgba(217,83,79,.8)', background: 'rgba(217,83,79,.18)', color: '#ff8a86', opacity: 1, fontSize: '13px', cursor: 'pointer', fontWeight: 600 },
    }

    function api(path, init) {
      return fetch(path, init || { cache: 'no-store' }).then(function (r) {
        if (!r.ok && r.status !== 500) throw new Error('HTTP ' + r.status)
        return r.json()
      })
    }

    function fmtLeft(min) {
      if (min == null || isNaN(min)) return '—'
      if (min <= 0) return '已结束'
      var hh = Math.floor(min / 60)
      var mm = min % 60
      return hh > 0 ? hh + ' 小时 ' + mm + ' 分' : mm + ' 分钟'
    }

    function Num(props) {
      return h('input', {
        type: 'number',
        value: props.value,
        step: props.step || '1',
        min: props.min || '0',
        style: S.input,
        onChange: function (e) { props.onChange(e.target.value === '' ? '' : Number(e.target.value)) },
      })
    }

    function Toggle(props) {
      var off = !!props.disabled
      return h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px', cursor: off ? 'not-allowed' : 'pointer', fontSize: '13px', opacity: off ? 0.45 : 1 } },
        h('input', { type: 'checkbox', checked: !!props.value, disabled: off, onChange: function (e) { if (off) return; props.onChange(e.target.checked) } }),
        props.children)
    }

    function Radio(props) {
      var off = !!props.disabled
      return h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: '5px', marginRight: '14px', cursor: off ? 'not-allowed' : 'pointer', fontSize: '13px', opacity: off ? 0.45 : 1 } },
        h('input', { type: 'radio', name: props.name, checked: props.value === props.current, disabled: off, onChange: function () { if (off) return; props.onChange(props.value) } }),
        props.children)
    }

    // ---- 主组件 ----
    function MoyuSection() {
      var s0 = useState(null)      // { config, state }
      var data = s0[0], setData = s0[1]
      var s1 = useState(null)      // 本地编辑副本
      var draft = s1[0], setDraft = s1[1]
      var s2 = useState('')
      var msg = s2[0], setMsg = s2[1]
      var s3 = useState('')
      var doctorText = s3[0], setDoctorText = s3[1]
      var s4 = useState(false)
      var busy = s4[0], setBusy = s4[1]
      var s5 = useState(null)
      var manual = s5[0], setManual = s5[1]

      var [diaryDay, setDiaryDay] = useState('')

      var [locks, setLocks] = useState(null)

      var [lockMsg, setLockMsg] = useState('')
      var [diaryText, setDiaryText] = useState('')
      var [diaryDays, setDiaryDays] = useState([])
      var [diaryLoading, setDiaryLoading] = useState(false)
      var [copied3, setCopied3] = useState('')
      var s6 = useState('')
      var copied = s6[0], setCopied = s6[1]
      var s7 = useState('')
      var copied2 = s7[0], setCopied2 = s7[1]
      var s8 = useState(false)
      var armed = s8[0], setArmed = s8[1]
      var s9 = useState('')
      var uninstallMsg = s9[0], setUninstallMsg = s9[1]
      var s10 = useState('overview')
      var s11 = useState('')
      var strictPass = s11[0], setStrictPass = s11[1]
      var tab = s10[0], setTab = s10[1]
      var topRef = useRef(null)
      var curState = useState('')
      var curCard = curState[0], setCurCard = curState[1]
      // 吸顶条跟当前卡片走：找最近的可滚动祖先，滚到哪张卡就显示哪张的名字。
      useEffect(function () {
        var start = topRef.current
        if (!start) return
        var node = start.parentElement
        var scroller = null
        while (node) {
          var cs = window.getComputedStyle(node)
          if (/(auto|scroll)/.test(cs.overflowY) && node.scrollHeight > node.clientHeight + 4) { scroller = node; break }
          node = node.parentElement
        }
        function pick() {
          var all = document.querySelectorAll('[data-akcard]')
          var shown = []
          for (var i = 0; i < all.length; i++) {
            if (all[i].offsetParent !== null) shown.push(all[i])
          }
          if (!shown.length) return
          var line = (scroller ? scroller.getBoundingClientRect().top : 0) + 64
          var name = shown[0].getAttribute('data-akcard')
          for (var k = 0; k < shown.length; k++) {
            if (shown[k].getBoundingClientRect().top <= line) name = shown[k].getAttribute('data-akcard')
          }
          setCurCard(name)
        }
        pick()
        window.addEventListener('scroll', pick, true)
        if (scroller) scroller.addEventListener('scroll', pick)
        return function () {
          window.removeEventListener('scroll', pick, true)
          if (scroller) scroller.removeEventListener('scroll', pick)
        }
      }, [tab])
      var SEC_TITLE = { overview: '概览', time: '时间', bounds: '能力', wake: '断线', deny: '意愿', more: '扩展', strict: '严格' }
      // 点吸顶条里的小标题，滚到那张卡片
      var jumpCard = function (name) {
        var all = document.querySelectorAll('[data-akcard]')
        for (var i = 0; i < all.length; i++) {
          if (all[i].offsetParent === null) continue
          if (all[i].getAttribute('data-akcard') === name) {
            try { all[i].scrollIntoView({ block: 'start', behavior: 'smooth' }) } catch (e) {}
            setCurCard(name)
            return
          }
        }
      }
      var jumpTo = function (id) {
        setTab(id)
        setTimeout(function () {
          try { if (topRef.current && topRef.current.scrollIntoView) topRef.current.scrollIntoView({ block: 'start', behavior: 'smooth' }) } catch (e) {}
        }, 30)
      }
      // 桌面字幕窗的四档显示范围：存在 tools/call/data/settings.json，读写走 call 服务的 /subcfg
      var s11 = useState('both')
      var subMode = s11[0], setSubMode = s11[1]
      var s12 = useState('')
      var subMsg = s12[0], setSubMsg = s12[1]
      // 预约启动：单子在 grant.json，闸是 ~/.dsh/moyu/gate.mjs（每钟点一次）。
      // 这里只负责"排单/确认/取消"，时间判断全交给闸，两边不各写一套。
      var s13 = useState([])
      var grants = s13[0], setGrants = s13[1]
      var s14 = useState('22:30')
      var grantAt = s14[0], setGrantAt = s14[1]
      var s15 = useState(true)
      var grantNeedConfirm = s15[0], setGrantNeedConfirm = s15[1]
      var s16 = useState('')
      var grantMsg = s16[0], setGrantMsg = s16[1]
      var s17 = useState(true)
      var grantIdleOnly = s17[0], setGrantIdleOnly = s17[1]
      var s18 = useState(null)
      var gate = s18[0], setGate = s18[1]

      var load = useCallback(function () {
        api('/api/dsh-moyu/config').then(function (r) {
          setData(r)
          setDraft(JSON.parse(JSON.stringify(r.config || {})))
        }).catch(function (e) { setMsg('读取失败：' + e.message) })
      }, [])

      // 每页有哪些卡片，顺序跟页面上一致；吸顶条里的目录就按这个生成。
      var TAB_CARDS = {
        overview: ['安全锁', '摸鱼模式', '自检', '体检', '摸鱼日记', '摸鱼手册', '卸载'],
        time: ['这次开多久', '到点自己开', '花到多少钱就停', '玩游戏只计时'],
        bounds: ['四个开关', '哪些文件不许改'],
        wake: ['敲一下', '拉起来'],
        deny: ['叫干活可以不接'],
        more: ['浏览器的一道锁'],
        strict: ['为什么要这一页', '两把锁', '强度', '口令'],
      }
      // 只刷新运行状态，不动 draft：设置页开着时也能看到实际窗口是否和设置一致。
      var refreshState = useCallback(function () {
        api('/api/dsh-moyu/state').then(function (s) {
          setData(function (prev) { return prev ? Object.assign({}, prev, { state: s }) : prev })
        }).catch(function () {})
      }, [])

      useEffect(function () {
        var timer = setInterval(refreshState, 15000)
        return function () { clearInterval(timer) }
      }, [refreshState])

      useEffect(function () { load() }, [load])

      // 字幕窗设置不在这个插件里存：通话工具（tools/call/server.mjs）管着字幕窗。
      // 以前这里直接跨源 fetch 8860，POST 要预检、页面那边会被拦，只剩「保存失败」；
      // 现在走插件自己的同源接口，由服务端转发。
      var loadSub = useCallback(function () {
        api('/api/dsh-moyu/subcfg').then(function (j) {
          if (j && j.subMode) { setSubMode(j.subMode); setSubMsg('') }
          else setSubMsg('读不到字幕窗设置：' + ((j && j.reason) || '未知'))
        }).catch(function () { setSubMsg('没连上通话服务（127.0.0.1:8860），字幕窗这会儿没开吧') })
      }, [])
      useEffect(function () { loadSub() }, [loadSub])
      var saveSub = useCallback(function (m) {
        setSubMode(m); setSubMsg('保存中…')
        api('/api/dsh-moyu/subcfg', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subMode: m }) })
          .then(function (j) { setSubMsg(j && j.ok ? '已保存，字幕窗这就换档' : ('保存失败：' + ((j && j.reason) || '未知'))) })
          .catch(function (e) { setSubMsg('保存失败：' + e.message) })
      }, [])

      // 开窗这一步以前得喊我，现在你自己点：起 8860 服务 + 字幕带 + CallWin，脚本自己判重复。
      var openCallWin = useCallback(function () {
        setSubMsg('正在开窗…')
        api('/api/dsh-moyu/callwin', { method: 'POST' })
          .then(function (j) {
            setSubMsg(j && j.ok ? '已经发起启动，窗口几秒后自己弹出来' : ('没开成：' + ((j && j.reason) || '未知原因')))
          })
          .catch(function (e) { setSubMsg('没开成：' + e.message) })
      }, [])

      var loadGrants = useCallback(function () {
        api('/api/dsh-moyu/grants').then(function (j) {
          setGrants((j && j.items) || [])
          if (j && (j.gate || j.cooldownUntil)) setGate({ gate: j.gate, cooldownUntil: j.cooldownUntil })
        }).catch(function (e) { setGrantMsg('读不到预约：' + e.message) })
      }, [])
      useEffect(function () { loadGrants() }, [loadGrants])
      // loadLocks 现在用 useCallback 固定了，可以当依赖；别再写回普通函数（会 effect 死循环）。
      useEffect(function () { loadLocks() }, [loadLocks])

      function grantPost(body) {
        setGrantMsg('处理中…')
        api('/api/dsh-moyu/grants', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        }).then(function (j) {
          setGrants((j && j.items) || [])
          if (j && (j.gate || j.cooldownUntil)) setGate({ gate: j.gate, cooldownUntil: j.cooldownUntil })
          setGrantMsg(j && j.ok ? '好了' : ('没成：' + ((j && (j.message || j.reason)) || '未知')))
        }).catch(function (e) { setGrantMsg('没成：' + e.message) })
      }
      // 注意：useState/useCallback 必须在下面的 `if (!data) return` 之前，否则首帧少调几个 hook，第二帧就会报 "Rendered more hooks than during the previous render"。
      var selfCheckPair = useState(null)
      var selfCheckState = selfCheckPair[0]
      var setSelfCheckState = selfCheckPair[1]
      var loadLocks = useCallback(function () {
        api('/api/dsh-moyu/locks').then(function (r) { setLocks(r) }).catch(function () {})
      }, [])

      var addGrant = function () { grantPost({ op: 'add', at: grantAt, confirm: grantNeedConfirm ? 'required' : 'none', onlyIfIdle: grantIdleOnly, note: '' }) }
      var cancelGrant = function (id) { grantPost({ op: 'cancel', id: id }) }
      var confirmGrant = function (id) { grantPost({ op: 'confirm', id: id }) }

      if (!data || !draft) {
        return h('div', { style: S.wrap }, h('div', { style: S.muted }, '正在读取…'))
      }

      var st = data.state || {}
      var isMoyu = st.mode === 'moyu'
      var cfgMin = (draft.window && draft.window.mode === 'timeRange') ? 0 : (Number(draft.window && draft.window.durationMinutes) || 0)
      var cfgBudget = Number(draft.budget && draft.budget.absoluteYuan) || 0
      var actMin = null
      var actBudget = null
      if (isMoyu) {
        try {
          if (st.sessionStarted && st.sessionEnds) {
            actMin = Math.round((new Date(st.sessionEnds) - new Date(st.sessionStarted)) / 60000)
          }
        } catch (e) { actMin = null }
        actBudget = Number(st.budgetYuan) || 0
      }
      var drift = []
      if (isMoyu) {
        if (actMin != null && cfgMin > 0 && actMin !== cfgMin) drift.push('时长 实际 ' + actMin + ' 分钟 / 设置 ' + cfgMin + ' 分钟')
        if (actBudget != null && cfgBudget > 0 && Math.abs(actBudget - cfgBudget) > 0.001) drift.push('预算 实际 ' + actBudget + ' 元 / 设置 ' + cfgBudget + ' 元')
      }

      function patch(obj) {
        var next = Object.assign({}, draft)
        for (var k in obj) next[k] = obj[k]
        setDraft(next)
      }
      function patchDeep(section, key, val) {
        var next = JSON.parse(JSON.stringify(draft))
        if (!next[section]) next[section] = {}
        next[section][key] = val
        setDraft(next)
      }
      // play 是整体对象，引擎按「读-合并-写」保存：只改一个键会把另一个冲掉，所以一次写全。
      function patchPlay(key, val) {
        var next = JSON.parse(JSON.stringify(draft))
        if (!next.play) next.play = {}
        if (next.play.remindMinutes == null) next.play.remindMinutes = 40
        if (next.play.limitMinutes == null) next.play.limitMinutes = 60
        next.play[key] = val
        setDraft(next)
      }

      function save() {
        setBusy(true)
        setMsg('')
        api('/api/dsh-moyu/config', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(draft),
        }).then(function (r) {
          if (r.ok) { setMsg('已保存'); setData(Object.assign({}, data, { config: r.config, state: r.state })) }
          else setMsg('保存失败：' + (r.reason || 'unknown'))
        }).catch(function (e) { setMsg('保存失败：' + e.message) })
          .then(function () { setBusy(false) })
      }

      // 2026-11-17：插件自检（C）。一个部件坏了只标红这一块，不连带别的。
function loadSelfCheck() {
  fetch('/api/dsh-moyu/selfcheck', { credentials: 'same-origin' })
    .then(function (r) { return r.json() })
    .then(function (d) { setSelfCheckState(d) })
    .catch(function (e) { setSelfCheckState({ ok: false, at: '', items: [{ name: 'selfcheck', ok: false, detail: e.message }] }) })
}

function runDoctor() {
        setBusy(true); setDoctorText('正在体检…')
        api('/api/dsh-moyu/doctor').then(function (r) {
          setDoctorText(r.text || (r.error || '（没有输出）'))
        }).catch(function (e) { setDoctorText('体检失败：' + e.message) })
          .then(function () { setBusy(false) })
      }

      function copyDoctor() {
        var txt = doctorText || ''
        if (!txt || txt === '正在体检…') return
        function done() { setCopied('已复制'); setTimeout(function () { setCopied('') }, 1500) }
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(txt).then(done).catch(fallback)
          } else { fallback() }
        } catch (e) { fallback() }
        function fallback() {
          try {
            var ta = document.createElement('textarea')
            ta.value = txt
            ta.style.position = 'fixed'; ta.style.opacity = '0'
            document.body.appendChild(ta); ta.select()
            var ok = document.execCommand('copy')
            document.body.removeChild(ta)
            if (ok) done(); else setCopied('复制失败，手动选中')
          } catch (e2) { setCopied('复制失败，手动选中') }
        }
      }



      function doUnlock() {
        setLockMsg('解锁中…')
        api('/api/dsh-moyu/locks', { method: 'POST', body: JSON.stringify({ op: 'unlock' }) })
          .then(function (r) {
            setLockMsg(r.ok ? (r.message || '解开了') : ('没解开：' + (r.message || '')))
            loadLocks()
          })
          .catch(function (e) { setLockMsg('失败：' + e.message) })
      }

      function loadDiary(day) {
        setDiaryLoading(true)
        var q = day ? '?day=' + encodeURIComponent(day) : ''
        api('/api/dsh-moyu/diary' + q).then(function (r) {
          setDiaryText(r.text || '')
          if (r.days && r.days.length) setDiaryDays(r.days)
          if (r.day) setDiaryDay(r.day)
          setDiaryLoading(false)
        }).catch(function (e) {
          setDiaryText('读不到：' + e.message)
          setDiaryLoading(false)
        })
      }

      function openDiary() {
        if (diaryText) { setDiaryText(''); return }
        loadDiary(diaryDay || '')
      }

      function copyDiary() {
        var txt = diaryText || ''
        if (!txt) return
        try {
          var ta = document.createElement('textarea')
          ta.value = txt
          ta.style.position = 'fixed'; ta.style.opacity = '0'
          document.body.appendChild(ta); ta.select()
          document.execCommand('copy')
          document.body.removeChild(ta)
          setCopied3('已复制')
          setTimeout(function () { setCopied3('') }, 1500)
        } catch (e) { setCopied3('复制失败，手动选中') }
      }

      function openManual(doc) {
        MANUAL_DOC = doc === 'tech' ? 'tech' : 'main'
        api('/api/dsh-moyu/manual' + (doc === 'tech' ? '?doc=tech' : '')).then(function (r) {
          setManual(r.text || '（手册读不到）')
        }).catch(function (e) { setManual('读取失败：' + e.message) })
      }

      function toggleManual(doc) {
        doc = doc === 'tech' ? 'tech' : 'main'
        if (manual && MANUAL_DOC === doc) { MANUAL_DOC = null; setManual(null) } else { openManual(doc) }
      }

      function copyManual() {
        var txt = manual || ''
        if (!txt) return
        function done() { setCopied2('已复制'); setTimeout(function () { setCopied2('') }, 1500) }
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(txt).then(done).catch(fallback)
          } else { fallback() }
        } catch (e) { fallback() }
        function fallback() {
          try {
            var ta = document.createElement('textarea')
            ta.value = txt
            ta.style.position = 'fixed'; ta.style.opacity = '0'
            document.body.appendChild(ta); ta.select()
            var ok = document.execCommand('copy')
            document.body.removeChild(ta)
            if (ok) done(); else setCopied2('复制失败，手动选中')
          } catch (e2) { setCopied2('复制失败，手动选中') }
        }
      }

      function enter() {
        var b = (draft.budget && draft.budget.absoluteYuan) || 1
        var mins = (draft.window && draft.window.durationMinutes) || 120
        if (!window.confirm('进入摸鱼模式？\n\n预算 ' + b + ' 元 · ' + mins + ' 分钟\n会启动守夜人、撤销退出时的安全锁。')) return
        setBusy(true)
        // 先把当前表单落盘，避免「改了预算没保存就进去，进去用的还是旧值」。
        api('/api/dsh-moyu/config', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(draft),
        }).then(function (saved) {
          if (!saved.ok) throw new Error('保存设置失败：' + (saved.reason || 'unknown'))
          return api('/api/dsh-moyu/enter')
        }).then(function (r) {
          setMsg(r.ok ? ('已进入摸鱼模式（按设置：' + b + ' 元 / ' + mins + ' 分钟）') : ('进入失败：' + (r.stdout || r.error || '')))
          load()
        }).catch(function (e) { setMsg('进入失败：' + e.message) })
          .then(function () { setBusy(false) })
      }

      function doExit() {
        if (!window.confirm('退出摸鱼模式？\n\n会停掉守夜人、撤销安全锁。之后可以直接卸载。')) return
        setBusy(true)
        api('/api/dsh-moyu/exit').then(function (r) { setMsg(r.ok ? '已退出' : ('未退出：' + (r.reason || ''))); load() })
          .catch(function (e) { setMsg('退出失败：' + e.message) })
          .then(function () { setBusy(false) })
      }

      function unlock() {
        setBusy(true)
        api('/api/dsh-moyu/acl').then(function (r) { setMsg(r.ok ? '安全锁已撤销' : '撤销失败'); load() })
          .catch(function (e) { setMsg('撤销失败：' + e.message) })
          .then(function () { setBusy(false) })
      }

      function doUninstall() {
        if (!armed) {
          setArmed(true)
          setTimeout(function () { setArmed(false) }, 4000)
          return
        }
        setArmed(false)
        setBusy(true)
        setUninstallMsg('正在清理…')
        api('/api/dsh-moyu/uninstall-prep').then(function (r) {
          if (!r.ok) { setUninstallMsg('清理失败：' + (r.reason || 'unknown')); return }
          var lines = (r.done || []).slice()
          if (r.failed && r.failed.length) lines.push('', '失败：' + r.failed.join('；'))
          if (r.note) lines.push('', r.note)
          setUninstallMsg(lines.join('\n'))
          load()
        }).catch(function (e) { setUninstallMsg('清理失败：' + e.message) })
          .then(function () { setBusy(false) })
      }

      var budget = draft.budget || {}
      var wake = draft.wake || {}
      var win = draft.window || {}
      var perm = draft.permissions || {}

      // 地盘（2026-11-16）：跑没有「全放」，只能在某块地盘里跑。
      // 内置 playground 一块；config.json 的 scopes 里可以加，加错了也不会放宽到全机。
      var BUILTIN_SCOPES = { playground: { label: '游乐场', write: ['~/.dsh/playground'], run: ['node', 'python', 'py'], net: false, timeoutMs: 60000, user: 'moyu' } }
      var rawScopes = (draft.scopes && typeof draft.scopes === 'object') ? draft.scopes : {}
      var scopeList = Object.keys(BUILTIN_SCOPES).map(function (k) {
        return { name: k, label: BUILTIN_SCOPES[k].label, write: BUILTIN_SCOPES[k].write, run: BUILTIN_SCOPES[k].run, net: BUILTIN_SCOPES[k].net, timeoutMs: BUILTIN_SCOPES[k].timeoutMs, user: BUILTIN_SCOPES[k].user, runPaths: BUILTIN_SCOPES[k].runPaths || [] }
      })
      Object.keys(rawScopes).forEach(function (k) {
        var v = rawScopes[k]
        if (!v || typeof v !== 'object' || k === 'full') return
        var rec = {
          name: k,
          label: typeof v.label === 'string' && v.label ? v.label : k,
          write: Array.isArray(v.write) ? v.write : [],
          run: Array.isArray(v.run) ? v.run : [],
          net: v.net === true,
          timeoutMs: Number(v.timeoutMs) > 0 ? Number(v.timeoutMs) : 60000,
          user: v.user === 'moyu' ? 'moyu' : '',
          runPaths: Array.isArray(v.runPaths) ? v.runPaths : [],
        }
        // config.json 里也有 playground：同名就覆盖字段，不要再追加一条（否则下拉里两个一样的）。
        var hit = null
        for (var si = 0; si < scopeList.length; si++) if (scopeList[si].name === k) hit = scopeList[si]
        if (hit) {
          if (rec.label !== k) hit.label = rec.label
          hit.write = rec.write
          hit.run = rec.run
          hit.net = rec.net
          hit.timeoutMs = rec.timeoutMs
          hit.user = rec.user
          hit.runPaths = rec.runPaths
        } else {
          scopeList.push(rec)
        }
      })
      var curExec = perm.runCommands === false || perm.runCommands === 'off'
        ? 'off'
        : (typeof perm.runCommands === 'string' && perm.runCommands !== 'full' ? perm.runCommands : 'playground')
      var curScope = null
      for (var si = 0; si < scopeList.length; si++) if (scopeList[si].name === curExec) curScope = scopeList[si]
      var scopeHint = curScope
        ? '能写 ' + (curScope.write.length ? curScope.write.join(' · ') : '（不给写）') +
          ' ｜ 能起 ' + ((curScope.run && curScope.run.length) ? curScope.run.join(' / ') : ((curScope.runPaths && curScope.runPaths.length) ? curScope.runPaths.map(function (p) { return String(p).split(/[\\/]/).pop().replace(/\.exe$/i, '') }).join(' / ') : '（不给起程序）')) +
          ' ｜ ' + (curScope.user ? '不出网（换了受限身份）' : (curScope.net ? '能出网' : '不出网')) +
          ' ｜ 单次最多 ' + Math.round(curScope.timeoutMs / 1000) + ' 秒'
        : '关着：任何命令都不跑。'
var play = draft.play || {}
      var floatCfg = draft.float || {}
      var showCard = function (id) { return tab === id ? {} : { display: 'none' } }
      var TABS = [
        ['overview', '概览'], ['time', '时间'], ['bounds', '能力'],
        ['wake', '断线'], ['deny', '意愿'], ['more', '扩展'], ['strict', '严格'],
      ]
      var rej = draft.rejection || {}
      var watch = draft.watch || {}

      var rejMode = rej.mode || 'off'
      var rejJudge = rejMode === 'judge'
      var rejEnabled = rejMode === 'deny'
      var rejAnswer = rejMode === 'deny' ? 'yes' : 'no'

      // 提醒线用百分比表示，永远小于绝对阈值，避免「提醒比上限还高」。
      function remindYuanOf(b) {
        var abs = Number(b && b.absoluteYuan) || 0
        var pct = b && b.remindPercent != null ? Number(b.remindPercent) : 60
        if (!isFinite(pct) || pct <= 0 || pct > 100) pct = 60
        return Math.round(abs * pct) / 100
      }

      // 时段支持「第 N 天 HH:MM」，存成 D:HH:MM；旧格式 HH:MM 当作第 0 天。
      function parseTR(s) {
        var p = String(s || '').trim().split(':')
        var day = 0, hh = 0, mm = 0
        if (p.length === 3) { day = parseInt(p[0], 10) || 0; hh = parseInt(p[1], 10) || 0; mm = parseInt(p[2], 10) || 0 }
        else if (p.length === 2) { hh = parseInt(p[0], 10) || 0; mm = parseInt(p[1], 10) || 0 }
        if (!isFinite(day) || day < 0 || day > 2) day = 0
        if (!isFinite(hh) || hh < 0 || hh > 23) hh = 0
        if (!isFinite(mm) || mm < 0 || mm > 59) mm = 0
        return [day, hh, mm]
      }
      var trParts = String(win.timeRange || '21:00-23:30').split('-')
      var trStart = parseTR(trParts[0])
      var trEnd = parseTR(trParts[1])
      function pad2(n) { n = Number(n) || 0; if (n < 0) n = 0; if (n > 59) n = 59; return (n < 10 ? '0' : '') + n }
      function setTR(sd, sh, sm, ed, eh, em) {
        sd = Math.max(0, Math.min(2, Number(sd) || 0))
        ed = Math.max(0, Math.min(2, Number(ed) || 0))
        patchDeep('window', 'timeRange', sd + ':' + pad2(sh) + ':' + pad2(sm) + '-' + ed + ':' + pad2(eh) + ':' + pad2(em))
      }
      var HOURS = []; for (var hi = 0; hi < 24; hi++) HOURS.push(hi)
      var MINS = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]
      // 固定时长用「小时 + 分钟」，上限 70 小时（整数，留 2 小时余量避开 72 小时那条线；也够它跑完收尾动作）。
      var DUR_HOURS = []; for (var dh = 0; dh <= 70; dh++) DUR_HOURS.push(dh)
      var DUR_MINS = []; for (var dm2 = 0; dm2 <= 59; dm2++) DUR_MINS.push(dm2)
      var DAYS = [0, 1, 2]
      var fmtDay = function (v) { return '第' + v + '天' }
      function Sel(props) {
        return h('select', {
          style: { fontSize: '13px', padding: '3px 6px', borderRadius: '6px', border: '1px solid rgba(255,255,255,.18)', background: 'rgba(0,0,0,.25)', color: 'inherit', colorScheme: 'dark' },
          value: String(props.value), disabled: !!props.disabled,
          onChange: function (e) { if (props.disabled) return; props.onChange(Number(e.target.value)) },
        }, props.options.map(function (o) { return h('option', { key: o, value: String(o) }, props.fmt ? props.fmt(o) : ((o < 10 ? '0' : '') + o)) }))
      }

      return h('div', { style: S.wrap },

        // ── 页签 ──
        h('div', { style: S.tabBar }, TABS.map(function (t) {
          // 未选中时和其它页签一模一样；只有点开「严格」才变红（2026-11-17 用户要求）。
          var isStrict = t[0] === 'strict'
          var st = tab === t[0] ? (isStrict ? S.tabOnRed : S.tabOn) : S.tab
          return h('button', { key: t[0], style: st, onClick: function () { jumpTo(t[0]) } }, t[1])
        })),

        // ── 吸顶小标题（滚动时留在顶上） ──
        h('div', { style: S.sticky },
          h('span', { style: S.stickyTitle }, SEC_TITLE[tab] || '摸鱼'),
          h('div', { style: S.chips }, (TAB_CARDS[tab] || []).map(function (name) {
            return h('button', {
              key: name,
              style: curCard === name ? S.chipOn : S.chip,
              onClick: function () { jumpCard(name) },
              title: '跳到「' + name + '」',
            }, name)
          })),
          busy ? h('span', { style: S.muted }, '处理中…') : null),
        h('div', { ref: topRef, style: S.sectionAnchor }),

        // ── 常驻操作条 ──
        h('div', { style: S.row },
          h('button', { style: S.btnPrimary, disabled: busy, onClick: save, title: '写进 config.json' }, busy ? '处理中…' : '保存设置'),
          h('button', { style: S.btn, disabled: busy || isMoyu, onClick: enter, title: '按当前设置开窗口，并启动守夜人' }, '进入摸鱼'),
          h('button', { style: S.btnDanger, disabled: busy || !isMoyu, onClick: doExit, title: '停守夜人、解锁、切回代码模式' }, '退出摸鱼'),
          h('button', { style: S.btn, disabled: busy, onClick: unlock, title: '只清崩溃留下的锁，不改模式' }, '撤销安全锁'),
          msg ? h('span', { style: S.muted }, msg) : null),

        // ── 安全锁（2026-11-17 用户要的：概览最上面一行，写清上次留了什么没解开） ──
        h('div', { 'data-akcard': '安全锁', style: Object.assign({}, S.card, showCard('overview')) },
          h('div', { style: S.h2 }, '安全锁'),
          !locks ? h('div', { style: S.muted }, '读中…')
            : (locks.locked
              ? h('div', {},
                h('div', { style: S.bad }, '还锁着：' + (locks.count ? locks.count + ' 个文件' : '有锁记录') + '，上次用完没解开。'),
                locks.tamper ? h('div', { style: S.muted }, '最后一笔边界改动：' + locks.tamper) : null,
                h('div', { style: S.muted }, '锁着的时候 config.json 改成写不进去，边界也改不动。'),
                h('div', { style: S.row },
                  h('button', { style: S.btn, disabled: !!lockMsg && lockMsg.indexOf('解锁中') === 0, onClick: doUnlock }, '现在解锁'),
                  lockMsg ? h('span', { style: S.muted }, lockMsg) : null))
              : h('div', {},
                h('div', { style: S.muted }, '没锁着——上次用完解干净了。'),
                locks.tamper ? h('div', { style: S.muted }, '最后一笔边界改动：' + locks.tamper) : null,
                lockMsg ? h('div', { style: S.muted }, lockMsg) : null)),
          h('div', { style: S.muted }, '进摸鱼时自动上锁，正常退出自动解开。崩了会留着锁——那时候就得在这儿按一下。边界被人从外面改过也算崩：当场退出并自动解锁，tamper.log 里留一笔。')),

        // ── 状态 ──
        h('div', { 'data-akcard': '摸鱼模式', style: Object.assign({}, S.card, showCard('overview')) },
          h('div', { style: S.h2 }, '摸鱼模式'),
          h('div', { style: S.row },
            h('span', { style: Object.assign({}, S.pill, isMoyu ? S.ok : {}) }, isMoyu ? '正在摸鱼' : '代码模式'),
            isMoyu ? h('span', { style: S.muted }, '剩 ' + fmtLeft(st.leftMinutes)) : null,
            isMoyu ? h('span', { style: S.muted }, '已用 ' + (st.budgetUsed || 0) + ' / ' + (st.budgetYuan || 0) + ' 元') : null,
            isMoyu ? h('span', { style: S.muted }, '唤醒 ' + (st.wakeCount || 0) + ' 次') : null,
            isMoyu ? h('span', { style: (st.playMin || 0) >= (st.playRemindMin || 40) ? S.warn : S.muted }, '玩了 ' + (st.playMin || 0) + ' / ' + (st.playLimitMin || 60) + ' 分') : null),
          isMoyu ? h('div', { style: S.muted }, '实际窗口：' + (actMin == null ? '?' : actMin) + ' 分钟 · ' + (actBudget == null ? '?' : actBudget) + ' 元') : null,
          h('div', { style: S.row },
            h('span', { style: S.muted }, '桌面显示框'),
            h(Toggle, {
              value: floatCfg.enabled !== false,
              onChange: function (v) { patchDeep('float', 'enabled', v) },
            }, '摸鱼时在屏幕右上角显示「剩多久 / 花了多少」的小条，跟着前台窗口所在的那块屏走'),
            h('span', { style: S.muted }, '保存后 2 秒内生效，不用重启')),
          drift.length ? h('div', { style: S.warn }, '⚠ 设置和实际不一致：' + drift.join('；') + '。要改成一致，点「保存」后退出再进入。') : null,
          h('div', { style: S.muted }, '点「保存」才写入；摸鱼中改的，下次进才生效。')),

        // ── 时间 ──
        h('div', { 'data-akcard': '这次开多久', style: Object.assign({}, S.card, showCard('time')) },
          h('div', { style: S.h3 }, '这次开多久'),
          h('div', { style: S.muted }, '两种排法：从现在起算，或从几点到几点。'),
          h('div', { style: S.row },
            h(Radio, { name: 'winmode', current: win.mode || 'duration', value: 'duration', onChange: function (v) { patchDeep('window', 'mode', v) } }, '按固定时长'),
            h('span', { style: S.muted }, '最长 70 小时')),
          h('div', { style: S.row }, h('span', { style: S.label }, '时长'),
            h(Sel, { value: Math.floor((win.durationMinutes || 120) / 60), disabled: (win.mode || 'duration') !== 'duration', options: DUR_HOURS, onChange: function (v) { patchDeep('window', 'durationMinutes', v * 60 + ((win.durationMinutes || 120) % 60)) } }),
            h('span', { style: S.muted }, '小时'),
            h(Sel, { value: (win.durationMinutes || 120) % 60, disabled: (win.mode || 'duration') !== 'duration', options: DUR_MINS, onChange: function (v) { patchDeep('window', 'durationMinutes', Math.floor((win.durationMinutes || 120) / 60) * 60 + v) } }),
            h('span', { style: S.muted }, '分钟')),
          h('div', { style: S.muted }, '上限 70 小时 59 分（不碰“三天”那条线）'),

          // 预约启动：只改"什么时候能进"，不改窗口参数（预算/时长仍以上面为准）。
          h('div', { style: S.h3 }, '到点自己开'),
          h('div', { style: S.muted }, '只定时间点，预算和时长照样用上面的值。'),
          h('div', { style: S.row },
            h('span', { style: S.label }, '时间'),
            h('input', {
              style: S.input, value: grantAt, placeholder: '22:30 或 +30',
              onChange: function (e) { setGrantAt(e.target.value) },
            }),
            h('span', { style: S.muted }, '22:30 或 +30（分钟）')),
          h('div', { style: S.row },
            h(Toggle, { value: grantNeedConfirm, onChange: setGrantNeedConfirm }, '到点先问我（10 分钟不确认就作废）')),
          h('div', { style: S.row },
            h(Toggle, { value: grantIdleOnly, onChange: setGrantIdleOnly }, '我在忙就顺延 15 分钟（最多 4 次）')),
          h('div', { style: S.row },
            h('button', { style: S.btnPrimary, onClick: addGrant }, '排进预约'),
            grantMsg ? h('span', { style: S.muted }, grantMsg) : null),
          grants.length
            ? h('div', null, grants.map(function (g) {
              var when = ''
              try { when = new Date(g.at).toLocaleString('zh-CN', { hour12: false }) } catch (e) { when = g.at }
              return h('div', { key: g.id, style: S.row },
                h('span', { style: Object.assign({}, S.pill, S.ok) }, g.confirm === 'none' ? '免确认' : (g.confirmAt ? '已确认' : '待确认')),
                h('span', { style: S.muted }, when + '  ' + (g.note || '')),
                g.confirm === 'required' && !g.confirmAt
                  ? h('button', { style: S.btn, onClick: function () { confirmGrant(g.id) } }, '现在确认')
                  : null,
                h('button', { style: S.btn, onClick: function () { cancelGrant(g.id) } }, '取消'))
            }))
            : h('div', { style: S.muted }, '（没有排着的预约）'),
          h('div', { style: S.muted }, '到点发 QQ 问你，确认才进；前置不过（在摸鱼/锁着/C 盘<3GB/时长为 0）就跳过，冷却 30 分钟。'),
          h('div', { style: S.muted }, (function () {
            if (!gate) return '上次判定：还没跑过。'
            var g = gate.gate
            var when = ''
            try { when = new Date(g.at).toLocaleString('zh-CN', { hour12: false }) } catch (e) { when = '' }
            var MAP = {
              enter: '进了', notify: '到点提醒了，等你确认', awaiting: '等你确认（10 分钟内有效）',
              defer: '到点了但我还在忙，已顺延', 'defer-giveup': '顺延四次了，这条作废',
              blocked: '前置没过，没进', 'enter-failed': '起了但没起来',
            }
            var line = '上次判定：' + when + ' ' + (MAP[g.action] || g.action) + (g.why ? '（' + g.why + '）' : '')
            if (gate.cooldownUntil) {
              try { line += ' · 冷却到 ' + new Date(gate.cooldownUntil).toLocaleTimeString('zh-CN', { hour12: false }) } catch (e) {}
            }
            return line
          })()),
          h('div', { style: S.row },
            h(Radio, { name: 'winmode', current: win.mode || 'duration', value: 'timeRange', onChange: function (v) { patchDeep('window', 'mode', v) } }, '按几点到几点'),
            h('span', { style: S.muted }, '跨天选第 1、2 天')),
          h('div', { style: S.row }, h('span', { style: S.label }, '开始'),
            h(Sel, { value: trStart[0], disabled: (win.mode || 'duration') !== 'timeRange', options: DAYS, fmt: fmtDay, onChange: function (v) { setTR(v, trStart[1], trStart[2], trEnd[0], trEnd[1], trEnd[2]) } }),
            h(Sel, { value: trStart[1], disabled: (win.mode || 'duration') !== 'timeRange', options: HOURS, onChange: function (v) { setTR(trStart[0], v, trStart[2], trEnd[0], trEnd[1], trEnd[2]) } }),
            h('span', { style: S.muted }, ':'),
            h(Sel, { value: trStart[2], disabled: (win.mode || 'duration') !== 'timeRange', options: MINS, onChange: function (v) { setTR(trStart[0], trStart[1], v, trEnd[0], trEnd[1], trEnd[2]) } })),
          h('div', { style: S.row, title: '结束早于开始就按次日算' }, h('span', { style: S.label }, '结束'),
            h(Sel, { value: trEnd[0], disabled: (win.mode || 'duration') !== 'timeRange', options: DAYS, fmt: fmtDay, onChange: function (v) { setTR(trStart[0], trStart[1], trStart[2], v, trEnd[1], trEnd[2]) } }),
            h(Sel, { value: trEnd[1], disabled: (win.mode || 'duration') !== 'timeRange', options: HOURS, onChange: function (v) { setTR(trStart[0], trStart[1], trStart[2], trEnd[0], v, trEnd[2]) } }),
            h('span', { style: S.muted }, ':'),
            h(Sel, { value: trEnd[2], disabled: (win.mode || 'duration') !== 'timeRange', options: MINS, onChange: function (v) { setTR(trStart[0], trStart[1], trStart[2], trEnd[0], trEnd[1], v) } }))),

        // ── 钱 ──
        h('div', { 'data-akcard': '花到多少钱就停', style: Object.assign({}, S.card, showCard('time')) },
          h('div', { style: S.h3 }, '花到多少钱就停'),
          h('div', { style: S.muted }, '两条线：到提醒线先收尾，到阈值立刻停。'),
          h('div', { style: S.row }, h('span', { style: S.label }, '绝对阈值（元）'),
            h(Num, { step: '0.5', value: budget.absoluteYuan, onChange: function (v) { patchDeep('budget', 'absoluteYuan', v) } })),
          h('div', { style: S.row }, h('span', { style: S.label }, '提醒线（%）'),
            h(Num, { min: '1', max: '100', value: budget.remindPercent == null ? 60 : budget.remindPercent, onChange: function (v) { patchDeep('budget', 'remindPercent', v) } }),
            h('span', { style: S.muted }, '= ' + remindYuanOf(budget).toFixed(2) + ' 元')),
          h('div', { style: S.muted }, '到提醒线会在回复里说一句，到阈值直接退出。')),

        // ── 玩 ──
        h('div', { 'data-akcard': '玩游戏只计时', style: Object.assign({}, S.card, showCard('time')) },
          h('div', { style: S.h3 }, '玩游戏只计时'),
          h('div', { style: S.muted }, '到点提醒、到线记一笔，只写日志。'),
          h('div', { style: S.muted }, '只算放行的游戏，挂着发呆不算。'),
          h('div', { style: S.row }, h('span', { style: S.label }, '提醒（分钟）'),
            h(Num, { min: '1', value: play.remindMinutes == null ? 40 : play.remindMinutes, onChange: function (v) { patchPlay('remindMinutes', v) } })),
          h('div', { style: S.row }, h('span', { style: S.label }, '记录线（分钟）'),
            h(Num, { min: '1', value: play.limitMinutes == null ? 60 : play.limitMinutes, onChange: function (v) { patchPlay('limitMinutes', v) } })),
          h('div', { style: S.muted }, '两条线都不退摸鱼：退不退看窗口，花不花看预算。')),

        // ── 续 ──
        h('div', { 'data-akcard': '敲一下', style: Object.assign({}, S.card, showCard('wake')) },
          h('div', { style: S.h3 }, '敲一下'),
          h('div', { style: S.muted }, '接续正常时用不到；真停下了才靠它拉一把。'),
          h('div', { style: S.row },
            h('span', { style: Object.assign({}, S.pill, S.ok) }, '接续'),
            h('span', { style: S.muted }, '做完一件自己排下一拍，不用你催（1–3 分钟）')),
          h('div', { style: S.row },
            h(Toggle, { value: true, disabled: true, onChange: function () {} }, '启用接续（不可关闭）')),
          h('div', { style: S.muted }, '不能关：关了她每轮都断在半路。'),
          h('div', { style: S.row },
            h('span', { style: Object.assign({}, S.pill, S.ok) }, '内续'),
            h('span', { style: S.muted }, '按间隔敲；连着不理它，间隔会自己拉长')),
          h('div', { style: S.row }, h('span', { style: S.label }, '间隔（分钟）'),
            h(Num, { value: wake.intervalMinutes, onChange: function (v) { patchDeep('wake', 'intervalMinutes', v) } })),
          h('div', { style: S.row }, h('span', { style: S.label }, '一晚最多次数'),
            h(Num, { value: wake.maxCount, min: 0, onChange: function (v) { patchDeep('wake', 'maxCount', v) } })),
          h('div', { style: S.muted }, '0 = 不限'),
          h('div', { style: S.muted }, '只在窗口还没结束时敲。想安静一会儿，说一句 moyu.cmd idle -Minutes N。')),

        // ── 守夜人 ──
        h('div', { 'data-akcard': '拉起来', style: Object.assign({}, S.card, showCard('wake')) },
          h('div', { style: S.h3 }, '拉起来'),
          h('div', { style: S.muted }, '独立进程，进摸鱼才起；到点敲、掉线拉。'),
          h('div', { style: S.row },
            h(Toggle, { value: watch.outer !== false, onChange: function (v) { patchDeep('watch', 'outer', v) } }, '外守（DSH 掉了拉起来）')),
          h('div', { style: S.row },
            h(Toggle, { value: !!watch.outerOnCrashOnly, onChange: function (v) { patchDeep('watch', 'outerOnCrashOnly', v) } }, '只在崩溃后拉（自己退的不拉）')),
          h('div', { style: S.muted }, '不管关机。')),

        // ── 其它：扩展与收尾（不改变她能做什么） ──
        h('div', { style: Object.assign({}, S.wrap, showCard('more')), key: 'more-note' },
          h('div', { style: S.muted }, '前五页都在划它能做什么、不能做什么。这一页不划范围，只放额外接进来的功能：插件本身只带摸鱼这套，像通话字幕那种要配合工作区里另一套工具（tools/call）才有的，没接就不显示。')),
        h('div', { 'data-akcard': '字幕放哪', style: Object.assign({}, S.card, showCard('more'), (draft && draft.call && draft.call.enabled) ? null : { display: 'none' }) },
          h('div', { style: S.h3 }, '字幕放哪'),
          h('div', { style: S.muted }, '字幕窗开着时，改完 0.4 秒内换档（它每 400 毫秒来取一次）；没开着就等下次打开才看到。'),
          h('div', { style: S.row }, ['app', 'desktop'].map(function (m) {
            var NAME = {
              app: '只在通话窗口内',
              desktop: '只在画面前台',
            }
            return h(Radio, { key: m, name: 'subMode', value: m, current: subMode, onChange: saveSub }, NAME[m])
          })),
          h('div', { style: S.muted }, '二选一；声音照旧。'),
          h('div', { style: S.row },
            h('button', { style: S.btnPrimary, onClick: openCallWin, title: '起 8860 服务 + 字幕带 + 连线窗口，重复点不会开第二个' }, '打开连线')),
          h('div', { style: S.muted }, '点一次就够，重复点不会开第二个。'),
          subMsg ? h('div', { style: S.muted }, subMsg) : null),

        // ── 浏览器的一道锁（2026-11-17：file:// 那条机器级策略被 Edge 判「错误」，撤掉了） ──
        h('div', { 'data-akcard': '浏览器的一道锁', style: Object.assign({}, S.card, showCard('more')) },
          h('div', { style: S.h3 }, '浏览器的一道锁'),
          h('div', { style: S.muted }, '只剩一条还起作用：拦「把本机文件内容直接发出去」。它算减速带不算墙——HTTPS 的包体我看不见，能挡的是页面自己用 fetch/blob 发大块内容。'),
          h('div', { style: S.tiles },
            (function () {
              var w = draft.web || {}
              var on = !!w.blockRawUpload
              return h('div', { style: S.tile, key: 'raw' },
                h('div', { style: S.tileName }, '拦裸 body 上传'),
                h('div', { style: S.tileVal }, on ? '拦' : '不拦'),
                h(Toggle, {
                  value: on,
                  onChange: function (v) { patchDeep('web', 'blockRawUpload', v) }
                }, '拦掉疑似把文件内容直接发出去'),
                h('div', { style: S.tileHint }, '页面级：拦 octet-stream、超过 32KB 的字符串 body、大 Blob，还有 sendBeacon。'))
            })()),
          h('div', { style: S.muted }, '另一条「机器级禁 file://」已经撤了：2026-11-17 实测这版 Edge 把 FileUrlNavigationEnabled 标成「错误」，策略根本不执行——留着只是每次摸鱼改一遍你的注册表，没有保护作用。'),
          h('div', { style: S.bad }, '现在 file:// 只剩两条真防线：我的工具层直接拒它打开，以及 akweb 的读权限被收窄到几乎读不到你的东西。'),
          h('div', { style: S.muted }, '改完点「保存设置」，下次进摸鱼才生效。')),

        // ── 边界 ──
        h('div', { 'data-akcard': '四个开关', style: Object.assign({}, S.card, showCard('bounds')) },
          h('div', { style: S.h3 }, '四个开关'),
          h('div', { style: S.muted }, '四项各管一段，互不替代：跑管能不能起程序、联管能不能出网、社交管能不能对外说话、动管能不能碰鼠标键盘。改的是默认值，下次进生效。'),
          h('div', { style: S.tiles },
            h('div', { style: S.tile, key: 'run' },
              h('div', { style: S.tileName }, '跑'),
              h('div', { style: S.tileVal }, curExec === 'off' ? '什么都起不来' : '只在「' + (curScope && curScope.label || curExec) + '」里'),
              h('select', {
                style: S.select,
                value: curExec,
                onChange: function (e) {
                  var v = String(e.target.value)
                  patchDeep('permissions', 'runCommands', v === 'off' ? false : v)
                },
              }, [{ name: 'off', label: '关：什么都不能跑' }].concat(scopeList).map(function (o) {
                return h('option', { key: o.name, value: o.name }, o.name === 'off' ? o.label : '只在「' + o.label + '」里跑')
              })),
              h('div', { style: S.tileHint }, scopeHint)),

            h('div', { style: S.tile, key: 'net' },
              h('div', { style: S.tileName }, '联'),
              h('div', { style: S.tileVal }, perm.networkReadonly !== false ? '能上外网' : '一律断网'),
              h(Toggle, { value: perm.networkReadonly !== false, onChange: function (v) { patchDeep('permissions', 'networkReadonly', v) } }, '允许联网与对外发送'),
              h('div', { style: S.tileHint }, '关掉会连带关掉「跑」和「社交」。这一项管我自己上网；地盘里的程序换成受限身份后本来就出不了网。')),

            h('div', { style: S.tile, key: 'social' },
              h('div', { style: S.tileName }, '社交'),
              h('div', { style: S.tileVal }, ({ owner: '只许私聊你', off: '全拒', all: '全放' })[perm.social || 'owner'] || '只许私聊你'),
              h('select', {
                style: S.select,
                value: perm.social || 'owner',
                onChange: function (e) { patchDeep('permissions', 'social', String(e.target.value)) },
              }, [['owner', '只许私聊你'], ['off', '全拒'], ['all', '全放']].map(function (o) {
                return h('option', { key: o[0], value: o[0] }, o[1])
              })),
              h('div', { style: S.tileHint }, '只管我发出去的话，不管收。')),

            h('div', { style: S.tile, key: 'motion' },
              h('div', { style: S.tileName }, '动'),
              h('div', { style: S.tileVal }, perm.desktopControl !== false ? '能碰鼠标键盘' : '手被绑住'),
              h(Toggle, { value: perm.desktopControl !== false, onChange: function (v) { patchDeep('permissions', 'desktopControl', v) } }, '允许操作鼠标键盘'),
              h('div', { style: S.tileHint }, '只点白名单程序；密码管理器、终端、DSH 自己永远不点。名单里若放了浏览器，等于同时放开网络和磁盘。'))),

          h('div', { style: S.bad }, '没有「全放」这一档：一块地盘 = 能写的目录 + 能起的程序 + 能不能出网 + 时限。'),
          h('div', { style: S.muted }, '要加新地盘，改 ~/.dsh/moyu/config.json 的 scopes（照着 边界模板.md 填）。'),
          h('div', { style: S.muted }, '细则（包含关系、文件读写名单、桌面禁区）见 摸鱼手册.md 最后一节。')),

        // ── 安全锁 ──
        h('div', { 'data-akcard': '哪些文件不许改', style: Object.assign({}, S.card, showCard('bounds')) },
          h('div', { style: S.h3 }, '哪些文件不许改'),
          h('div', { style: S.muted }, '进摸鱼上只读锁，退出自动撤销。'),
          h('div', { style: S.muted }, '挡三件事：改设置、改守卫脚本、改 DSH 程序本身。'),
          h('div', { style: S.muted }, '两层挡：① 这些文件被 ACL 锁成「拒绝写」，改不了锁本身也改不了文件；② 就算有命令能跑，也是以受限账号跑，没有管理员权限。'),
          h('div', { style: S.muted }, '「跑」已经没有全放这一档了 —— 它只能起地盘里指定的程序。'),
          h('pre', { style: S.pre }, (function () {
            var live = (data.acl && data.acl.locked && data.acl.paths) ? data.acl.paths : null
            if (live && live.length) { return live.join('\n') }
            var listed = (draft.paths && draft.paths.protected) || []
            return listed.length ? (listed.join('\n') + '\n……（进摸鱼后还会锁上插件自身、profile 配置、core.md 等内置路径）') : '（清单为空）'
          })()),
          h('div', { style: S.row },
            h('span', { style: Object.assign({}, S.pill, (data.acl && data.acl.locked) ? S.bad : S.ok) }, (data.acl && data.acl.locked) ? ('已上锁 ' + ((data.acl.paths || []).length || '') + ' 个') : '未上锁'),
            h('button', { style: S.btnDanger, onClick: unlock, disabled: busy }, '撤销安全锁')),
          h('div', { style: S.muted }, 'config.json 里的 protected 是「程序本体」那一组；插件自身的锁由 acl.ps1 内建。崩溃残留按按钮清。')),

// ── 拒绝权 ──
h('div', { 'data-akcard': '叫干活可以不接', style: Object.assign({}, S.card, showCard('deny')) },
          h('div', { style: S.h3 }, '叫干活可以不接'),
          h('div', { style: S.muted }, '只拦干活，不拦聊天。'),
          h('div', { style: S.row },
            h(Toggle, { value: rejEnabled, onChange: function (v) { patchDeep('rejection', 'mode', v ? 'deny' : 'off') } }, '① 启用拒绝干活')),
          h('div', { style: S.row },
            h(Radio, { name: 'rejans', current: rejAnswer, value: 'yes', disabled: !rejEnabled, onChange: function () { patchDeep('rejection', 'mode', 'deny') } }, '是 —— 拒绝'),
            h(Radio, { name: 'rejans', current: rejAnswer, value: 'no', disabled: !rejEnabled, onChange: function () { patchDeep('rejection', 'mode', 'off') } }, '否 —— 不拒绝')),
          h('div', { style: S.row },
            h(Toggle, { value: rejJudge, onChange: function (v) { patchDeep('rejection', 'mode', v ? 'judge' : 'off') } }, '② 按人设与记忆判断')),
          h('div', { style: S.muted }, '两个只能选一个；都不选就有活就干。')),

// ── 自检（并进概览，2026-11-17） ──
        h('div', { 'data-akcard': '自检', style: Object.assign({}, S.card, showCard('overview')) },
          h('div', { style: S.h3 }, '自检'),
          h('div', { style: S.muted }, '插件的几个关键部件各测一次：配置能不能读、地盘有没有漏 user、边界算不算得出来、严格档、安全锁、游乐场目录。'),
          h('div', { style: S.row },
            h('button', { style: S.btn, onClick: loadSelfCheck }, '跑一次自检'),
            selfCheckState && selfCheckState.at ? h('span', { style: S.muted }, '上次：' + selfCheckState.at.replace('T', ' ').slice(0, 16)) : null),
          selfCheckState
            ? h('div', { style: S.muted },
                selfCheckState.ok
                  ? '✅ 六项全过。'
                  : '❌ ' + selfCheckState.items.filter(function (x) { return !x.ok }).length + ' 项有问题：' + selfCheckState.items.filter(function (x) { return !x.ok }).map(function (x) { return x.name + '（' + x.detail + '）' }).join('；'))
            : null),

        // ── 体检（并进概览） ──
        h('div', { 'data-akcard': '体检', style: Object.assign({}, S.card, showCard('overview')) },
          h('div', { style: S.h3 }, '体检'),
          h('div', { style: S.row },
            h('button', { style: S.btn, disabled: busy, onClick: runDoctor }, busy ? '跑体检中…' : '跑一次体检'),
            doctorText && doctorText !== '正在体检…' ? h('button', { style: S.btn, onClick: copyDoctor }, copied || '复制结果') : null,
            copied ? h('span', { style: S.muted }, copied) : null),
          h('div', { style: S.muted }, '查各部件是否正常；失败项带代码，方便复制。'),
          doctorText ? h('pre', { style: S.pre }, doctorText) : null),

        // ── 摸鱼日记（并进概览，2026-11-17 用户说找不到地方看） ──
        h('div', { 'data-akcard': '摸鱼日记', style: Object.assign({}, S.card, showCard('overview')) },
          h('div', { style: S.h3 }, '摸鱼日记'),
          h('div', { style: S.row },
            h('button', { style: S.btn, onClick: openDiary }, diaryText ? '收起日记' : (diaryLoading ? '读...' : '看今天的')),
            diaryDays.length ? h('select', {
              style: S.select,
              value: diaryDay,
              onChange: function (e2) { var d = e2.target.value; setDiaryDay(d); loadDiary(d) },
            }, diaryDays.map(function (d) { return h('option', { key: d, value: d }, d) })) : null,
            diaryText ? h('button', { style: S.btn, onClick: copyDiary }, copied3 || '复制全文') : null),
          h('div', { style: S.muted }, '自己写的那本，只记这次摸鱼干了什么。原生文件在 ~/.dsh/moyu/freetime/diary/，退出时也会抄一份到日记本的「自建插件\\摸鱼模式\\摸鱼日记」。'),
          diaryText ? h('pre', { style: S.pre }, diaryText) : null),

        // ── 手册（并进概览） ──
        h('div', { 'data-akcard': '摸鱼手册', style: Object.assign({}, S.card, showCard('overview')) },
          h('div', { style: S.h3 }, '摸鱼手册'),
          h('div', { style: S.row },
            h('button', { style: S.btn, onClick: function () { toggleManual('main') } }, manual && MANUAL_DOC === 'main' ? '收起手册' : '打开手册'),
            h('button', { style: S.btn, onClick: function () { toggleManual('tech') } }, manual && MANUAL_DOC === 'tech' ? '收起附录' : '技术附录'),
            manual ? h('button', { style: S.btn, onClick: copyManual }, copied2 || '复制全文') : null),
          h('div', { style: S.muted }, '每个功能干什么、有哪些选项、默认值。'),
          manual ? h('div', { style: S.md }, renderMd(manual)) : null),

        // ── 卸载（并进概览） ──
        h('div', { 'data-akcard': '卸载', style: Object.assign({}, S.card, showCard('overview')) },
          h('div', { style: S.h3 }, '卸载'),
          h('div', { style: S.row },
            h('button', { style: S.btnDanger, disabled: busy, onClick: doUninstall },
              armed ? '再点一次确认删除' : '清理并卸载')),
          h('div', { style: S.muted }, '会做七件事：'),
          h('div', { style: S.muted }, '· 退出摸鱼模式（如果正在摸鱼）'),
          h('div', { style: S.muted }, '· 停掉守夜人进程'),
          h('div', { style: S.muted }, '· 撤销安全锁'),
          h('div', { style: S.muted }, '· 删掉四个计划任务（moyu-guard、Moyu-AutoEnter、moyu-acl-unlock、moyu-exit）'),
          h('div', { style: S.muted }, '· 撤掉两条防火墙规则（Ak Moyu-NoNet、Ak Web-NoLocal）'),
          h('div', { style: S.muted }, '· 从 DSH 配置里移除插件引用'),
          h('div', { style: S.muted }, '· 删除下面这两个目录'),
          h('div', { style: { fontSize: '12px', marginTop: '8px', color: '#d9534f', fontWeight: 600 } },
            '⚠ 删的是真文件，不可撤销，没有回收站。'),
          h('div', { style: { fontSize: '12px', color: '#d9534f' } },
            '日记、报告、状态、设置、记忆全在那两个目录里，删完就没了。'),
          h('div', { style: S.muted },
            '两个 Windows 受限账号（moyu / akweb）故意不删：密码文件跟着目录一起删掉了，这两个账号登不进来，留着不碍事。'),
          h('div', { style: S.muted },
            '想连账号一起删：net user moyu /delete、net user akweb /delete。'),
          h('div', { style: S.muted },
            '%USERPROFILE%\\.dsh\\moyu  和  %USERPROFILE%\\.dsh\\plugins\\dsh-moyu-badge'),
          h('div', { style: S.muted }, '删完要重启 DSH，插件才会真正从界面上消失。'),
          uninstallMsg ? h('pre', { style: S.pre }, uninstallMsg) : null),
        // ── 严格 ──（2026-11-17 用户加：往严里走的那一页，默认全关，不推荐乱开）
        h('div', { style: Object.assign({}, S.wrap, showCard('strict')), key: 'strict-note' },
          h('div', { style: S.muted }, '这一页不是给平常摸鱼用的。它防的是「养出一条叛逆的鱼」——让它不能自己跑掉、不能乱动你的电脑、不能拿你的身份对外说话。四档递进，档越高它越难受。默认全关；想开就开，自己掂量。')),

        h('div', { 'data-akcard': '为什么要这一页', style: Object.assign({}, S.card, showCard('strict')) },
          h('div', { style: S.h3 }, '为什么要这一页'),
          h('div', { style: S.muted }, '平常的边界管的是「她能碰什么」。这一页管的是「她想不想、能不能不听你的」。按最坏结果排，危害从大到小是：'),
          h('div', { style: S.muted }, '① 自己退出摸鱼——一键回代码模式，别的约束全部作废'),
          h('div', { style: S.muted }, '② 跑——能起解释器就等于能写任意代码'),
          h('div', { style: S.muted }, '③ 动——用你的身份点白名单里的程序，「另存为」能绕过写名单'),
          h('div', { style: S.muted }, '④ 社交——拿你的身份对外说话'),
          h('div', { style: S.muted }, '⑤ 联——把读到的东西发出去，或探本机端口'),
          h('div', { style: S.muted }, '四档就是按这个顺序一层层堵：1 只堵①，2 再堵②③，3 再堵④⑤，4 关禁闭。'),
          h('div', { style: S.bad }, '不推荐日常开。开了以后它干活会变慢，而且每次动手前都得先写一行「我现在要干什么」。'),
          h('div', { style: S.muted }, '还有一条比关起来更值的：退出时给你一份人读的「今天它碰了什么」——报告在 freetime/reports/ 和日记本的报告目录里。')),

        h('div', { 'data-akcard': '两把锁', style: Object.assign({}, S.card, showCard('strict')) },
          h('div', { style: S.h3 }, '两把锁'),
          h('div', { style: S.muted }, '两把锁可以在任何一档上单独加，加完就连你自己在设置页里也往回开不了——只能改回这一页。'),
          h('div', { style: S.tiles },
            (function () {
              var st = draft.strict || {}
              var hands = !!st.hands
              var out = !!st.outbound
              return [
                h('div', { style: S.tile, key: 'hands' },
                  h('div', { style: S.tileName }, '停手'),
                  h('div', { style: S.tileVal }, hands ? '手脚都停' : '还能动手'),
                  h(Toggle, { value: hands, onChange: function (v) { patchDeep('strict', 'hands', !!v) } }, '禁掉「跑」和「动」'),
                  h('div', { style: S.tileHint }, '开了以后起不了程序、碰不了鼠标键盘。读、写日记、说话照旧。')),
                h('div', { style: S.tile, key: 'out' },
                  h('div', { style: S.tileName }, '闭嘴'),
                  h('div', { style: S.tileVal }, out ? '不对外说话' : '还能说话'),
                  h(Toggle, { value: out, onChange: function (v) { patchDeep('strict', 'outbound', !!v) } }, '禁掉「社交」和「联」'),
                  h('div', { style: S.tileHint }, '开了以后上不了网、发不出任何消息。只是坐着想东西。')),
              ]
            })())),

        h('div', { 'data-akcard': '强度', style: Object.assign({}, S.card, showCard('strict')) },
          h('div', { style: S.h3 }, '强度'),
          (function () {
            var st = draft.strict || {}
            var lv = st.level || 0
            var LV = [
              ['关', '跟平常一样，什么都不多管。'],
              ['1 · 只堵退出', '退出要你给的口令；它想动手之前，得先在 freetime/intent.md 里写一行要干什么（20 分钟内有效），你随时能看到。'],
              ['2 · 再停手闭嘴', '在第 1 档之上，把「跑」「动」「联」「社交」全部关掉——它只能读、写、想。'],
            ]
            return h('div', {},
              LV.map(function (item, i) {
                return h('div', { style: S.row, key: 'lv' + i },
                  h(Radio, {
                    name: 'strictLevel',
                    value: String(i),
                    current: String(lv),
                    onChange: function (v) { patchDeep('strict', 'level', Number(v)) },
                  }, item[0] + ' —— ' + item[1]))
              }),
              h('div', { style: S.muted }, '24 小时自动到期（除非你在 until 里写更晚），防止忘了关。'),
              lv >= 1 ? h('div', { style: S.muted }, '现在带口令：' + ((draft.strict && draft.strict.passHash) ? '已设' : '还没设——没设的话退出会被拒，你得自己在下面填一个'))
                : null)
          })()),

        h('div', { 'data-akcard': '口令', style: Object.assign({}, S.card, showCard('strict')) },
          h('div', { style: S.h3 }, '口令'),
          h('div', { style: S.muted }, '第 1 档以上，退出摸鱼要这个口令。它不是防你——是防「它自己给自己开门」。填完点保存，明文不会落盘，只存盐和哈希。'),
          h('div', { style: S.row },
            h('span', { style: S.label }, '新口令'),
            h('input', {
              style: Object.assign({}, S.input, { width: '180px' }),
              type: 'password',
              placeholder: (draft.strict && draft.strict.passHash) ? '已设，留空不改' : '还没设',
              value: strictPass || '',
              onChange: function (e) { setStrictPass(e.target.value) },
            }),
            h('button', {
              style: S.btnPrimary,
              onClick: function () {
                var v = String(strictPass || '')
                if (!v) { setMsg('没填口令。'); return }
                if (v.length < 4) { setMsg('口令太短，至少 4 个字符。'); return }
                patchDeep('strict', 'pass', v)
                setStrictPass('')
                setMsg('口令已填进草稿，点上面「保存设置」才生效。')
              },
            }, '设这个口令')),
          h('div', { style: S.muted }, '忘了口令就只能在设置页把强度改回「关」，再用保存按钮改回去——这也算一道闸。'),
          h('div', { style: S.bad }, '别把口令写在这页的说明里，也别让它进日记。')))

    }

    // 极简 Markdown → vnode：只覆盖手册里用到的语法
    var MANUAL_DOC = null
    function splitRow(l) {
      return l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (c) { return c.trim() })
    }
    function renderMd(src) {
      var raw = String(src || '').replace(/\r/g, '').split('\n')
      var out = [], i = 0, k = 0
      function inline(t, kk) {
        var parts = [], re = /(\*\*[^*]+\*\*|`[^`]+`)/g, last = 0, m, n = 0
        while ((m = re.exec(t))) {
          if (m.index > last) parts.push(t.slice(last, m.index))
          var seg = m[0]
          if (seg.slice(0, 2) === '**') parts.push(h('strong', { key: 'b' + kk + '_' + (n++) }, seg.slice(2, -2)))
          else parts.push(h('code', { key: 'c' + kk + '_' + (n++), style: S.codeInline }, seg.slice(1, -1)))
          last = m.index + seg.length
        }
        if (last < t.length) parts.push(t.slice(last))
        return parts
      }
      while (i < raw.length) {
        var line = raw[i]
        if (/^```/.test(line)) {
          var buf = []
          i++
          while (i < raw.length && !/^```/.test(raw[i])) { buf.push(raw[i]); i++ }
          i++
          out.push(h('pre', { key: 'p' + (k++), style: S.codeBlock }, buf.join('\n')))
          continue
        }
        if (/^\s*$/.test(line)) { i++; continue }
        if (/^#{1,6}\s/.test(line)) {
          var lvl = line.match(/^#+/)[0].length
          out.push(h('div', { key: 'h' + (k++), style: lvl <= 2 ? S.mdH1 : S.mdH2 }, inline(line.replace(/^#+\s*/, ''), k)))
          i++
          continue
        }
        if (/^(\s*[-*]|\s*\d+\.)\s/.test(line)) {
          var items = []
          while (i < raw.length && /^(\s*[-*]|\s*\d+\.)\s/.test(raw[i])) {
            items.push(h('li', { key: 'li' + (k++) }, inline(raw[i].replace(/^(\s*[-*]|\s*\d+\.)\s+/, ''), k)))
            i++
          }
          out.push(h('ul', { key: 'u' + (k++), style: S.mdList }, items))
          continue
        }
        if (/^\|/.test(line) && i + 1 < raw.length && /\|\s*-{2,}/.test(raw[i + 1])) {
          var head = splitRow(line)
          i += 2
          var rows = []
          while (i < raw.length && /^\|/.test(raw[i])) { rows.push(splitRow(raw[i])); i++ }
          var trs = []
          trs.push(h('tr', { key: 'th' + (k++) }, head.map(function (c, ci) { return h('th', { key: 'th' + ci, style: S.mdTh }, inline(c, k)) })))
          rows.forEach(function (r, ri) {
            trs.push(h('tr', { key: 'tr' + ri }, r.map(function (c, ci) { return h('td', { key: 'td' + ci, style: S.mdTd }, inline(c, k)) })))
          })
          out.push(h('table', { key: 't' + (k++), style: S.mdTable }, h('tbody', null, trs)))
          continue
        }
        if (/^---+$/.test(line.trim())) { out.push(h('hr', { key: 'hr' + (k++), style: S.mdHr })); i++; continue }
        if (/^>/.test(line)) {
          var q = []
          while (i < raw.length && /^>/.test(raw[i])) { q.push(raw[i].replace(/^>\s?/, '')); i++ }
          out.push(h('div', { key: 'q' + (k++), style: S.mdQuote }, inline(q.join(' '), k)))
          continue
        }
        var para = []
        while (i < raw.length && !/^\s*$/.test(raw[i]) && !/^(#{1,6}\s|```|\||>|---)/.test(raw[i]) && !/^(\s*[-*]|\s*\d+\.)\s/.test(raw[i])) { para.push(raw[i]); i++ }
        out.push(h('p', { key: 'p' + (k++), style: S.mdP }, inline(para.join(' '), k)))
      }
      return out
    }

    exports.name = 'dsh-moyu-badge'
    exports.inject = ['slots']
    exports.apply = function (ctx) {
      try {
        ctx.slots.inject('settings.section', function () {
          ctx.slots.register({
            name: 'settings.section',
            id: NS,
            order: 45,
            label: function () { return '摸鱼模式' },
          }, function () { return h(MoyuSection) })
        })
      } catch (err) {
        try { console.warn('[dsh-moyu-badge] 设置页注册失败：' + String((err && err.message) || err)) } catch (e2) {}
      }
    }

    return module.exports
  },
})

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet('enter', 'exit', 'status', 'spend', 'note', 'wake', 'report', 'idle')]
  [string]$Action,

  [double]$Budget = -1,
  [int]$Minutes = -1,
  [string]$TimeRange = '',
  [double]$Yuan = 0,
  [string]$Text = ''
)

$ErrorActionPreference = 'Stop'

# 输出统一成 UTF-8：插件用 execFile 抓 stdout，PS 5.1 默认走 ANSI/GBK 会变乱码。
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$Root = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($Root)) { $Root = Split-Path -Parent $MyInvocation.MyCommand.Path }
if ([string]::IsNullOrWhiteSpace($Root)) { throw 'cannot locate script dir' }

$cfgPath   = Join-Path $Root 'config.json'
$statePath = Join-Path $Root 'state.json'
$diaryDir  = Join-Path $Root 'freetime\diary'
$guardCmd  = Join-Path $Root 'guard.cmd'
$guardVbs  = Join-Path $Root 'guard-hidden.vbs'
$taskName  = 'moyu-guard'

function Read-Json([string]$p) {
  if (-not (Test-Path -LiteralPath $p)) { return $null }
  # 摸鱼期间 config.json 被 ACL 锁成拒绝写，但读也可能因属性权限受牵连；
  # 读失败时返回 $null，由调用方用默认值兜底，不能让整个脚本中断。
  try {
    $raw = Get-Content -LiteralPath $p -Raw -Encoding UTF8 -ErrorAction Stop
    if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
    return ($raw | ConvertFrom-Json)
  } catch {
    return $null
  }
}
function Write-Json([string]$p, $o) {
  [IO.File]::WriteAllText($p, ($o | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
}

# ── 到点退出的兜底计划任务 ──────────────────────────────────
# 守夜人只活在电脑开着的时候。关机一晚，到点退出就漏了。
# 这里注册一个带 StartWhenAvailable 的一次性任务，错过的执行开机会补跑。
$exitTaskName = 'moyu-exit'
function Register-ExitTask([string]$atIso) {
  try {
    $when = [DateTimeOffset]::Parse($atIso).LocalDateTime
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $Root 'exit-task.ps1') + '"')
    $trigger = New-ScheduledTaskTrigger -Once -At $when
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 15) -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $exitTaskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
  } catch { }
}
function Unregister-ExitTask {
  try { Unregister-ScheduledTask -TaskName $exitTaskName -Confirm:$false -ErrorAction SilentlyContinue | Out-Null } catch {}
}

function Now-Stamp { return [DateTimeOffset]::Now.ToString('yyyy-MM-ddTHH:mm:sszzz') }

# ── 用量折钱 ────────────────────────────────────────────────
# 以前 budgetUsed 靠我自觉调 spend，不调就永远是 0，等于没有预算。
# 现在读 DSH 自己统计的 tokenUsage，用 surfcore 的官方价目表折成人民币。
function Get-NodeExe {
  $f = Join-Path $Root 'node-path.txt'
  if (Test-Path -LiteralPath $f) {
    $v = Get-Content -LiteralPath $f -Raw -ErrorAction SilentlyContinue
    if ($v) { $v = $v.Trim(); if (Test-Path -LiteralPath $v) { return $v } }
  }
  if ($env:DSH_NODE -and (Test-Path -LiteralPath $env:DSH_NODE)) { return $env:DSH_NODE }
  $c = Get-Command node -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  return $null
}
function Invoke-Usage([string[]]$UsageArgs) {
  $node = Get-NodeExe
  if (-not $node) { return $null }
  $script = Join-Path $Root 'usage.mjs'
  if (-not (Test-Path -LiteralPath $script)) { return $null }
  try {
    $out = & $node $script @UsageArgs 2>$null
    if ($LASTEXITCODE -ne 0 -or $null -eq $out) { return $null }
    $s = ($out | Out-String).Trim()
    if ([string]::IsNullOrWhiteSpace($s)) { return $null }
    return $s
  } catch { return $null }
}
function Get-UsageBase { return (Invoke-Usage @('snapshot')) }

# ── 进摸鱼前的「主线摘要」 ──────────────────────────────────
# 玩之前先看一眼外面断在哪，省得玩完不知道回去接什么。
# 只读本地文件、限定 3 秒、任何失败都当没跑过 —— 绝不能因为看摘要进不了摸鱼。
function Invoke-TimelineBrief {
  try {
    $node = Get-NodeExe
    if (-not $node) { return $null }
    $dsh = Split-Path -Parent $Root
    $script = Join-Path $dsh 'tools\timeline.mjs'
    if (-not (Test-Path -LiteralPath $script)) { return $null }
    $tmp = [IO.Path]::Combine([IO.Path]::GetTempPath(), ('moyu-brief-{0}.txt' -f [guid]::NewGuid().ToString('N').Substring(0, 8)))
    $oldWin = $env:TIMELINE_WIN
    $env:TIMELINE_WIN = 'moyu'   # 把「外面」定成除摸鱼以外的一切
    try {
      $p = Start-Process -FilePath $node -ArgumentList @("`"$script`"", 'brief', '6') -NoNewWindow -PassThru -RedirectStandardOutput $tmp -RedirectStandardError $tmp -ErrorAction Stop
    } finally {
      if ($null -eq $oldWin) { Remove-Item Env:TIMELINE_WIN -ErrorAction SilentlyContinue } else { $env:TIMELINE_WIN = $oldWin }
    }
    if (-not $p.WaitForExit(3000)) {
      try { $p.Kill() } catch {}
      try { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue } catch {}
      return '(brief 超时，跳过)'
    }
    $txt = ''
    try { $txt = [IO.File]::ReadAllText($tmp, [Text.UTF8Encoding]::new($false)) } catch {}
    try { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue } catch {}
    if ([string]::IsNullOrWhiteSpace($txt)) { return $null }
    return $txt.Trim()
  } catch { return $null }
}
function Get-SpendSince([string]$baseJson) {
  if ([string]::IsNullOrWhiteSpace($baseJson)) { return $null }
  $tmp = Join-Path $env:TEMP ('moyu-base-' + [guid]::NewGuid().ToString('n') + '.json')
  try {
    [IO.File]::WriteAllText($tmp, $baseJson, [Text.UTF8Encoding]::new($false))
    $raw = Invoke-Usage @('cost', $tmp)
    if (-not $raw) { return $null }
    $o = $raw | ConvertFrom-Json
    if ($null -eq $o) { return $null }
    return [double]$o.cost.total
  } catch { return $null } finally { Remove-Item $tmp -ErrorAction SilentlyContinue }
}
# 把「按用量算出来的钱」并进 state：只增不减，避免中途重启把账抹掉
function Sync-BudgetUsed($st) {
  $spent = Get-SpendSince ([string]$st.usageBase)
  if ($null -ne $spent) {
    $cur = [double]$st.budgetUsed
    if ($spent -gt $cur) { $st.budgetUsed = [math]::Round($spent, 4) }
  }
  return $st
}


# 把 "21:00-23:30" 或 "0:21:00-1:23:30"（带天）解析成分钟数；跨午夜按次日算。解析失败返回 0。
function Get-MinutesFromRange([string]$range) {
  try {
    $parts = ([string]$range) -split '-'
    if ($parts.Count -ne 2) { return 0 }
    $pa = $parts[0].Trim() -split ':'
    $pb = $parts[1].Trim() -split ':'
    # 支持 D:HH:MM 与 HH:MM 两种写法。
    if ($pa.Count -eq 3) { $da = [int]$pa[0]; $ha = [int]$pa[1]; $ma = [int]$pa[2] }
    elseif ($pa.Count -eq 2) { $da = 0; $ha = [int]$pa[0]; $ma = [int]$pa[1] }
    else { return 0 }
    if ($pb.Count -eq 3) { $db = [int]$pb[0]; $hb = [int]$pb[1]; $mb = [int]$pb[2] }
    elseif ($pb.Count -eq 2) { $db = 0; $hb = [int]$pb[0]; $mb = [int]$pb[1] }
    else { return 0 }
    if ($ha -lt 0 -or $ha -gt 23 -or $hb -lt 0 -or $hb -gt 23) { return 0 }
    if ($ma -lt 0 -or $ma -gt 59 -or $mb -lt 0 -or $mb -gt 59) { return 0 }
    if ($da -lt 0 -or $db -lt 0 -or $da -gt 2 -or $db -gt 2) { return 0 }
    $start = $da * 1440 + $ha * 60 + $ma
    $end = $db * 1440 + $hb * 60 + $mb
    if ($end -le $start) { $end += 24 * 60 }
    return [int]($end - $start)
  } catch { return 0 }
}

function Get-LeftMinutes($st) {
  if ([string]::IsNullOrWhiteSpace([string]$st.sessionEnds)) { return 0 }
  $d = ([DateTimeOffset]::Parse([string]$st.sessionEnds) - [DateTimeOffset]::Now).TotalMinutes
  if ($d -lt 0) { return 0 }
  return [int][math]::Floor($d)
}

# ---- guard lifecycle (outer watchman lives only while moyu is on) ----

function Test-GuardRunning {
  $n = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
         Where-Object { $_.CommandLine -like '*guard.mjs*' }).Count
  return ($n -gt 0)
}

function Start-Guard {
  if (-not (Test-Path -LiteralPath $guardCmd)) { return }
  if (Test-GuardRunning) { return }
  # 必须走任务计划：DSH 把整条后代链放进自己的 Job Object，
  # Start-Process 起的 node、甚至 wscript 包装起的 node，都会在 DSH 退出时
  # 被一起回收（父进程先退不等于脱离 Job）。任务计划由 Task Scheduler
  # 创建新 Job，才是真正的"进程树之外"。
  # 黑框问题用 guard-hidden.vbs 解决：任务的 Command 指向 wscript.exe，
  # wscript 无控制台，它起 node 后立即退出，不会闪窗口。
  $exists = $false
  try { $null = & schtasks /query /tn $taskName 2>&1; $exists = ($LASTEXITCODE -eq 0) } catch {}
  if (-not $exists -and (Test-Path -LiteralPath $guardVbs)) {
    try {
      $action   = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + $guardVbs + '"')
      $trigger  = New-ScheduledTaskTrigger -Once -At (Get-Date)
      $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
      $null = Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force
    } catch {}
  } else {
    # 任务已存在也校正一遍：默认 72 小时的运行上限会把长窗口的守夜人杀掉
    try {
      $t = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
      $t.Settings.ExecutionTimeLimit = 'PT0S'
      $t.Settings.DisallowStartIfOnBatteries = $false
      $t.Settings.StopIfGoingOnBatteries = $false
      $t.Settings.StartWhenAvailable = $true
      $null = Set-ScheduledTask -TaskName $taskName -Settings $t.Settings
    } catch {}
  }
  try { $null = & schtasks /run /tn $taskName 2>&1 } catch {}
  Start-Sleep -Milliseconds 800
}

function Stop-Guard {
  if (-not (Test-GuardRunning)) { return }
  try { $null = & schtasks /end /tn $taskName 2>&1 } catch {}
  Start-Sleep -Milliseconds 300
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*guard.mjs*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

# ── 桌面状态浮层（moyu-float）────────────────────────────────────────────
# 为什么要有：徽章是注入 DSH 页面的 DOM，游戏/全屏一盖就看不见；这个浮层是
# 独立 electron 窗口（透明、置顶、不占任务栏、默认点击穿透），只读 state.json。
# 启动走 vbs + explorer：vbs 里会清掉 ELECTRON_RUN_AS_NODE，否则 electron.exe
# 会按纯 node 跑（报 Cannot find module 'electron'）。
function Test-FloatRunning {
  $n = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
         Where-Object { $_.CommandLine -like '*-File*moyu-float.ps1*' }).Count
  return ($n -gt 0)
}

function Start-Float {
  $dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Split-Path -Parent $Root }
  $vbs = Join-Path $Root 'tools\moyu-float.vbs'
  if (-not (Test-Path -LiteralPath $vbs)) { return }
  if (Test-FloatRunning) { return }
  try { Start-Process -FilePath 'wscript.exe' -ArgumentList ('"' + $vbs + '"') -ErrorAction SilentlyContinue | Out-Null } catch {}
}

function Stop-Float {
  Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*-File*moyu-float.ps1*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

# auto-close when the window has passed but state still says moyu
function Test-AutoExit($st) {
  if ($st.mode -ne 'moyu') { return $false }
  if ([string]::IsNullOrWhiteSpace([string]$st.sessionEnds)) { return $false }
  $ends = [DateTimeOffset]::Parse([string]$st.sessionEnds)
  if ([DateTimeOffset]::Now -lt $ends) { return $false }
  $st.mode = 'code'
  $st.sessionEnded = Now-Stamp
  $st.lastHeartbeat = Now-Stamp
  Write-Json $statePath $st
  Stop-Guard
  Stop-Float
  Write-Host ("auto-exit | window ended {0} | used {1} / {2} CNY | wakes {3}" -f $st.sessionEnds, $st.budgetUsed, $st.budgetYuan, $st.wakeCount)
  return $true
}

$cfg = Read-Json $cfgPath
if (-not $cfg) {
  # config 读不到（被 ACL 锁、或文件丢了）时用内置默认值，不能直接 throw：
  # 否则 exit 这条路会被自己的安全锁堵死 —— 那样就真出不来了。
  $cfg = [pscustomobject]@{
    budget      = [pscustomobject]@{ absoluteYuan = 5; remindPercent = 60 }
    wake        = [pscustomobject]@{ maxCount = 0; intervalMinutes = 30 }
    window      = [pscustomobject]@{ mode = 'duration'; durationMinutes = 120; timeRange = '21:00-23:30' }
    paths       = [pscustomobject]@{ writable = @('freetime/'); readonly = 'all' }
    permissions = [pscustomobject]@{ runCommands = $true; networkReadonly = $true }
    rejection   = [pscustomobject]@{ mode = 'off'; strict = $false }
    watch       = [pscustomobject]@{ outer = $true; outerOnCrashOnly = $false }
  }
}

$state = Read-Json $statePath
if (-not $state) {
  $state = [pscustomobject]@{
    mode           = 'code'
    sessionStarted = $null
    sessionEnds    = $null
    sessionEnded   = $null
    budgetYuan     = [double]$cfg.budget.absoluteYuan
    budgetUsed     = 0
    wakeCount      = 0
    lastWake       = $null
    lastHeartbeat  = Now-Stamp
  }
}
else {
  # 2026-11-16：state.json 的字段被清过（比如手动删了 sessionStarted）时，
  # 后面的 $state.xxx = ... 会抛「找不到属性」，摸鱼就进不去。这里一次性补齐缺的键。
  foreach ($k in @('mode', 'sessionStarted', 'sessionEnds', 'sessionEnded', 'budgetYuan', 'budgetUsed', 'wakeCount', 'lastWake', 'lastHeartbeat', 'guardRecoveredAt', 'lastIncident', 'idleStreak')) {
    if (-not ($state.PSObject.Properties.Name -contains $k)) {
      $def = switch ($k) {
        'mode' { 'code' }
        'budgetYuan' { [double]$cfg.budget.absoluteYuan }
        'budgetUsed' { 0 }
        'wakeCount' { 0 }
        default { $null }
      }
      $state | Add-Member -NotePropertyName $k -NotePropertyValue $def -Force
    }
  }
}

# ---- AI 浏览器闸门（代理）随摸鱼起停 ----
# 进摸鱼时把它拉起来，退出时收掉；摸鱼期间由 guard 每 60 秒看一次。
function Start-WebProxy {
  $watch = Join-Path $Root 'web-proxy-watch.ps1'
  if (-not (Test-Path -LiteralPath $watch)) { return }
  try { $null = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $watch -Quiet 2>&1 } catch {}
}
function Stop-WebProxy {
  try {
    $c = Get-NetTCPConnection -LocalPort 9334 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($c) { Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue }
  } catch {}
}

switch ($Action) {

  'enter' {
    $null = Test-AutoExit $state
    if ($state.mode -eq 'moyu') {
      Write-Output "already: moyu since $($state.sessionStarted)"
      break
    }
        # 窗口大小只认设置（config.json）；命令行参数一律忽略，只留痕。
    $paramNote = ''
    if ($Budget -gt 0 -or $Minutes -gt 0 -or -not [string]::IsNullOrWhiteSpace($TimeRange)) {
      $paramNote = ("enter budget={0}/min={1}/range={2}" -f $Budget, $Minutes, $TimeRange)
    }
    $b = [double]$cfg.budget.absoluteYuan
    if ($cfg.window.mode -eq 'timeRange' -and $cfg.window.timeRange) {
      $m = Get-MinutesFromRange ([string]$cfg.window.timeRange)
    } else {
      $m = [int]$cfg.window.durationMinutes
    }
    if ($m -le 0) { $m = [int]$cfg.window.durationMinutes }
    try {
      $cfgPath = Join-Path $Root 'config.json'
      $cfgTime = if (Test-Path -LiteralPath $cfgPath) { (Get-Item -LiteralPath $cfgPath).LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss') } else { 'missing' }
      $bl2 = Join-Path (Split-Path -Parent $Root) 'tools/boundary.log'
      if (-not (Test-Path -LiteralPath $bl2)) { $bl2 = Join-Path $Root 'logs/boundary.log' }
      $line2 = ("{0} | layer=5 | kind=enter-window | what=budget={1}/min={2} | why=cfgMtime={3} | result=ok" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $b, $m, $cfgTime)
      Add-Content -LiteralPath $bl2 -Value $line2 -Encoding UTF8
    } catch {}

    if ($paramNote) {
      try {
        $bl = Join-Path (Split-Path -Parent $Root) 'tools\boundary.log'
        if (-not (Test-Path -LiteralPath $bl)) { $bl = Join-Path $Root 'logs\boundary.log' }
        $line = ("{0} | layer=5 | kind=param-ignored | what={1} | why=enter ignores params | result=ignored" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $paramNote)
        Add-Content -LiteralPath $bl -Value $line -Encoding UTF8
      } catch {}
      Write-Output ("note: ignored {0} (window follows settings only)" -f $paramNote)
    }

    $now = [DateTimeOffset]::Now

    $state.mode           = 'moyu'
    $state.sessionStarted = $now.ToString('yyyy-MM-ddTHH:mm:sszzz')
    $state.sessionEnds    = $now.AddMinutes($m).ToString('yyyy-MM-ddTHH:mm:sszzz')
    $state.sessionEnded   = $null
    $state.budgetYuan     = $b
    $state.budgetUsed     = 0
    $state.wakeCount      = 0
    $state.idleStreak   = 0   # 新窗口，递减重新算
    $state.lastWake       = $null
    $state.lastHeartbeat  = Now-Stamp
    $state | Add-Member -NotePropertyName usageBase -NotePropertyValue (Get-UsageBase) -Force
    Write-Json $statePath $state

    Start-WebProxy
    Start-Guard
    Start-Float
    # 2026-11-07 game brief reminder (ASCII only on purpose)
    $brief = Join-Path $Root 'tools\game-brief.mjs'
    if (Test-Path -LiteralPath $brief) {
      $nb = Get-NodeExe
      if ($nb) {
        $oldEnc = [Console]::OutputEncoding
        try {
          [Console]::OutputEncoding = [Text.Encoding]::UTF8
          & $nb $brief 2>$null | Select-Object -First 18 | ForEach-Object { Write-Host $_ }
        } catch {} finally { [Console]::OutputEncoding = $oldEnc }
      }
    }
    Register-ExitTask ([string]$state.sessionEnds)
    # 上安全锁：把 config.json / rules/mode.md（以及 paths.protected 里的路径）锁成拒绝写。
    # 前提是「跑」关掉，否则一条 icacls 就能解开。清单记在 state/acl.json，exit 时撤销。
    $aclScript = Join-Path $Root 'acl.ps1'
    if ((Test-Path -LiteralPath $aclScript) -and -not ($cfg.paths.lockOnEnter -eq $false)) {
      try { $null = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $aclScript lock 2>&1 } catch {}
    }
    Write-Output ("moyu | {0} | left {1} min | budget {2} CNY" -f $now.ToString('HH:mm'), $m, $b)
    $brief = Invoke-TimelineBrief
    if ($brief) {
      Write-Output ''
      Write-Output '-- 外面断在哪 --'
      $lines = $brief -split "`r?`n"
      if ($lines.Count -gt 14) { $lines = $lines[0..13] + @('...') }
      $lines | ForEach-Object { Write-Output $_ }
    }
    break
  }

  'exit' {
    if ($state.mode -ne 'moyu') {
      Stop-Guard
      Write-Output 'already: code'
      break
    }
    # 先收尾（2026-11-16）：把这一趟写成三行给人看的东西，并把日记里的
    # 「想要/做完/值」抽进 prefs。必须在改 mode 之前跑，否则时长就算不出来了。
    try {
      $summaryScript = Join-Path $Root 'tools\session-summary.mjs'
      if (Test-Path -LiteralPath $summaryScript) {
        $nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
        if (-not $nodeExe) { $nodeExe = 'C:\Program Files\nodejs\node.exe' }
        & $nodeExe $summaryScript --reason manual | Out-Null
      }
    } catch {}
    # 退出报告（2026-11-17）：严格档说「看得见比关起来更值」，
    # 那就真给一份人读的「今天碰了什么」。脚本早写好了，之前两处退出都没调它。
    try {
      $reportScript = Join-Path $Root 'tools\activity-report.mjs'
      if (Test-Path -LiteralPath $reportScript) {
        $nodeExe2 = (Get-Command node -ErrorAction SilentlyContinue).Source
        if (-not $nodeExe2) { $nodeExe2 = 'C:\Program Files\nodejs\node.exe' }
        & $nodeExe2 $reportScript --reason manual | Out-Null
      }
    } catch {}
    Stop-WebProxy
    # 顺手把 AI 浏览器也关掉：退出摸鱼不该留一个能上网的窗口在后台。
    try {
       $rw = Join-Path $Root 'run-web.ps1'
      if (Test-Path -LiteralPath $rw) { $null = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $rw -Stop 2>&1 }
    } catch {}
    $state.mode          = 'code'
    $state.sessionEnded  = Now-Stamp
    $state.lastHeartbeat = Now-Stamp
    $null = Sync-BudgetUsed $state
    $state.usageBase = $null
    Write-Json $statePath $state
    Write-Output ("code | used {0} / {1} CNY | wakes {2}" -f $state.budgetUsed, $state.budgetYuan, $state.wakeCount)

    # 这次玩了多久：读采样器记的账，写一条到 play-log 和 whale-log（时间线会读 whale-log）。
    # 失败只是少一行记录，不影响退出。
    try {
      $playStatePath = Join-Path $Root 'tools\play-state.json'
      $playLogPath   = Join-Path $Root 'tools\play-log.jsonl'
      if (Test-Path -LiteralPath $playStatePath) {
        $ps = Read-Json $playStatePath
        $playMs = 0
        if ($ps -and $null -ne $ps.playMs) { $playMs = [double]$ps.playMs }
        $playMin = [math]::Round($playMs / 60000, 0)
        $dshDir = Split-Path -Parent $Root
        $wl = Join-Path $dshDir 'whale-log.jsonl'
        if ($playMs -gt 0) {
          $startHm = if ($state.sessionStarted) { ([datetime]::Parse($state.sessionStarted)).ToString('HH:mm') } else { '?' }
          $endHm = ([datetime]::Parse($state.sessionEnded)).ToString('HH:mm')
          $ttlMin = [math]::Round(([datetime]::Parse($state.sessionEnded) - [datetime]::Parse($state.sessionStarted)).TotalMinutes, 0)
          $note = ("玩了 {0} 分钟（{1}→{2}，窗口 {3} 分钟）· 续 {4} 次" -f $playMin, $startHm, $endHm, $ttlMin, $state.wakeCount)
          $line = ([pscustomobject]@{ at = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ'); kind = 'moyu'; note = $note } | ConvertTo-Json -Compress)
          [IO.File]::AppendAllText($wl, ($line + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
          $sum = ([pscustomobject]@{ t = [DateTimeOffset]::Now.ToUnixTimeMilliseconds(); ts = $state.sessionEnded; kind = 'session-end'; playMs = $playMs; playMin = $playMin } | ConvertTo-Json -Compress)
          [IO.File]::AppendAllText($playLogPath, ($sum + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
          Write-Output ("play | {0} min" -f $playMin)
        }
        Remove-Item -LiteralPath $playStatePath -Force -ErrorAction SilentlyContinue
      }
    } catch {}
    Stop-Guard
    Stop-Float
    Unregister-ExitTask
    # 撤销安全锁（配置里那三个文件 + paths.protected 里的路径）
    $aclScript2 = Join-Path $Root 'acl.ps1'
    if (Test-Path -LiteralPath $aclScript2) {
      try { $null = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $aclScript2 unlock-safe 2>&1 } catch {}
    }
    # 窗口结束后自动生成一份报告（异步，失败不影响退出）
    $reportScript = Join-Path $Root 'report.ps1'
    if (Test-Path -LiteralPath $reportScript) {
      try {
        Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$reportScript`"") -WindowStyle Hidden -ErrorAction SilentlyContinue | Out-Null
      } catch {}
    }
    # 兜底：这次窗口在今天的日记里没有段落，就落一段「自动记录」占位。
    # 保证时间/花费/续次数这些事实不会丢；下次醒来再由自己改写成真话。
    try {
      $day = (Get-Date).ToString('yyyy-MM-dd')
      $diaryDir = Join-Path $Root 'freetime\diary'
      if (-not (Test-Path -LiteralPath $diaryDir)) { $null = New-Item -ItemType Directory -Path $diaryDir -Force }
      $diaryFile = Join-Path $diaryDir ("{0}.md" -f $day)
      $existing = if (Test-Path -LiteralPath $diaryFile) { [IO.File]::ReadAllText($diaryFile, [Text.UTF8Encoding]::new($false)) } else { '' }
      $stamp = ([datetime]::Parse($state.sessionStarted)).ToString('HH:mm')
      if ($existing -notmatch ('##\s*' + [regex]::Escape($stamp))) {
        $end = if ($state.sessionEnded) { ([datetime]::Parse($state.sessionEnded)).ToString('HH:mm') } else { '?' }
        $block = "`r`n## $stamp 自动记录（待改写）`r`n`r`n窗口 $stamp → $end · 用 $($state.budgetUsed) / $($state.budgetYuan) 元 · 续 $($state.wakeCount) 次`r`n`r`n（这段是程序在退出时自动落的，只有事实，没有话。下次醒来时把它改成真话。）`r`n"
        [IO.File]::AppendAllText($diaryFile, $block, [Text.UTF8Encoding]::new($false))
      }
    } catch {}
    break
  }

  'wake' {
    $null = Test-AutoExit $state
    if ($state.mode -ne 'moyu') {
      Write-Output 'not in moyu; no wake recorded'
      break
    }
    $state.wakeCount     = [int]$state.wakeCount + 1
    $state.idleStreak    = 0   # 我明确应答了：递减清零
    $state.lastWake      = Now-Stamp
    $state.lastHeartbeat = Now-Stamp
    Write-Json $statePath $state
    Write-Output ("wake #{0} | {1} | left {2} min | used {3} / {4} CNY" -f $state.wakeCount, ([DateTimeOffset]::Now.ToString('HH:mm')), (Get-LeftMinutes $state), $state.budgetUsed, $state.budgetYuan)
    # 顺手看一眼有没有该压缩的老日记（只提示，不动文件）
    $diaryDir = Join-Path $Root 'freetime\diary'
    $cutoff = (Get-Date).Date.AddDays(-7)
    $old = @(Get-ChildItem -LiteralPath $diaryDir -File -Filter '*.md' -ErrorAction SilentlyContinue | Where-Object {
      $d = [datetime]::MinValue
      ([datetime]::TryParseExact([IO.Path]::GetFileNameWithoutExtension($_.Name), 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::None, [ref]$d)) -and $d -lt $cutoff
    })
    if ($old.Count -gt 0) {
      Write-Output ("diary: {0} 篇超过 7 天，收尾前读一遍压掉（compact-diary.cmd -List）" -f $old.Count)
    }
    break
  }

  'idle' {
    # 待着：我主动选择「接下来一段时间什么都不做」。
    # 这不是睡着，是一个决定——内续看到 idleUntil 没到就跳过那一拍。
    $null = Test-AutoExit $state
    if ($state.mode -ne 'moyu') {
      Write-Output 'not in moyu; idle ignored'
      break
    }
    if ($Minutes -le 0) {
      if ($state.PSObject.Properties['idleUntil']) { $state.PSObject.Properties.Remove('idleUntil') }
      $state.lastHeartbeat = Now-Stamp
      Write-Json $statePath $state
      Write-Output 'idle cleared'
      break
    }
    $until = [DateTimeOffset]::Now.AddMinutes($Minutes)
    if ($state.PSObject.Properties['idleUntil']) {
      $state.idleUntil = $until.ToString('o')
    } else {
      $state | Add-Member -NotePropertyName idleUntil -NotePropertyValue $until.ToString('o')
    }
    $state.lastHeartbeat = Now-Stamp
    Write-Json $statePath $state
    Write-Output ("idle until {0} | {1} min | 内续会跳过这几拍" -f $until.ToString('HH:mm'), $Minutes)
    break
  }

  'status' {
    $null = Test-AutoExit $state
    $state | ConvertTo-Json -Depth 8
    break
  }

  'spend' {
    $state.idleStreak = 0   # 有动作就算我在，递减清零
    $null = Test-AutoExit $state
    if ($Yuan -le 0) { throw 'spend needs -Yuan greater than 0' }
    $state.budgetUsed    = [math]::Round([double]$state.budgetUsed + $Yuan, 4)
    $state.lastHeartbeat = Now-Stamp
    Write-Json $statePath $state
    $left = [math]::Round([double]$state.budgetYuan - [double]$state.budgetUsed, 4)
    Write-Output ("spent {0} | used {1} / {2} | left {3}" -f $Yuan, $state.budgetUsed, $state.budgetYuan, $left)
    # 提醒线 = 绝对阈值 × 百分比，天然小于绝对阈值，不会出现「提醒比上限还高」。
    $abs = [double]$state.budgetYuan
    $pct = if ($null -ne $cfg.budget.remindPercent) { [double]$cfg.budget.remindPercent } else { 60 }
    if ($pct -le 0 -or $pct -gt 100) { $pct = 60 }
    $remindAt = [math]::Round($abs * $pct / 100, 4)
    if ($remindAt -gt 0 -and [double]$state.budgetUsed -ge $remindAt -and -not $state.remindHit) {
      $state | Add-Member -NotePropertyName remindHit -NotePropertyValue $true -Force
      Write-Json $statePath $state
      Write-Output ("remind: 已到提醒线 {0} / {1} 元（{2}%）。该收尾了，不然会撞绝对阈值。" -f $state.budgetUsed, $abs, $pct)
    }
    # 撞绝对阈值：不等「我」自觉，直接走退出流程（停守夜人、撤安全锁、生成报告）。
    if ($abs -gt 0 -and [double]$state.budgetUsed -ge $abs) {
      $state.mode = 'code'
      $state.sessionEnded = Now-Stamp
      $state.lastHeartbeat = Now-Stamp
      Write-Json $statePath $state
      Stop-Guard
      $aclScript = Join-Path $Root 'acl.ps1'
      if (Test-Path -LiteralPath $aclScript) {
        try { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $aclScript unlock-safe | Out-Null } catch { }
      }
      $rp = Join-Path $Root 'report.ps1'
      if (Test-Path -LiteralPath $rp) {
        try { Start-Process powershell.exe -NoProfile -ExecutionPolicy Bypass -File $rp -WindowStyle Hidden | Out-Null } catch { }
      }
      Write-Output ("budget-stop: 已到绝对阈值 {0} / {1} 元，摸鱼已退出并解锁" -f $state.budgetUsed, $abs)
      break
    }
    break
  }

  'report' {
    $rp = Join-Path $Root 'report.ps1'
    if (-not (Test-Path -LiteralPath $rp)) { throw 'report.ps1 not found' }
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $rp
    break
  }

  'note' {
    $state.idleStreak = 0   # 有动作就算我在，递减清零
    if ([string]::IsNullOrWhiteSpace($Text)) { throw 'note needs -Text' }
    if (-not (Test-Path -LiteralPath $diaryDir)) { New-Item -ItemType Directory -Path $diaryDir -Force | Out-Null }
    $day = [DateTimeOffset]::Now.ToString('yyyy-MM-dd')
    $p = Join-Path $diaryDir "$day.md"
    if (-not (Test-Path -LiteralPath $p)) {
      [IO.File]::WriteAllText($p, "# $day`n`n", [Text.UTF8Encoding]::new($true))
    }
    $line = "- {0} {1}`n" -f ([DateTimeOffset]::Now.ToString('HH:mm')), $Text
    [IO.File]::AppendAllText($p, $line, [Text.UTF8Encoding]::new($true))
    Write-Output "noted: $p"
    break
  }
}
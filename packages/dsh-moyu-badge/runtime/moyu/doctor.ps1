# doctor.ps1 —— moyu 体检
# 输出格式参考 bili-whale 的「依赖体检」：
#   ✓ 名称 — 详情
#   ! 名称 — 警告原因（附排查代码）
#   ✗ 名称 — 失败原因（附排查代码）
# 目的：不成功的那一段，用中文说清楚，后面跟一行可复制的命令，方便丢给 DSH 排障。
param([string]$Root = '', [switch]$Fix, [string]$Report = '')

# 输出统一成 UTF-8：插件用 execFile 抓 stdout，PS 5.1 默认走 ANSI/GBK 会变乱码。
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$ErrorActionPreference = 'Continue'
$DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
if ([string]::IsNullOrWhiteSpace($Root)) {
  $Root = $PSScriptRoot
  if ([string]::IsNullOrWhiteSpace($Root)) { $Root = Split-Path -Parent $MyInvocation.MyCommand.Path }
}
if ([string]::IsNullOrWhiteSpace($Root) -or -not (Test-Path -LiteralPath $Root)) {
  Write-Host '✗ 目录 — 找不到 moyu 目录'
  exit 1
}

$script:okN = 0; $script:warnN = 0; $script:badN = 0
$script:rows = New-Object System.Collections.ArrayList
$script:fixOps = [ordered]@{}
function Line($level, $name, $detail, $code = '') {
  switch ($level) {
    'ok'   { $script:okN++ }
    'warn' { $script:warnN++ }
    'bad'  { $script:badN++ }
  }
  $null = $script:rows.Add([pscustomobject]@{ level = $level; name = $name; detail = $detail; code = $code })
  $mark = '✓'
  if ($level -eq 'warn') { $mark = '!' }
  elseif ($level -eq 'bad') { $mark = '✗' }
  Write-Host ("{0} {1} — {2}" -f $mark, $name, $detail)
  if ($code -and $level -ne 'ok') {
    Write-Host ("    代码：{0}" -f $code) -ForegroundColor DarkGray
  }
}
function ReadJson($p) {
  try { return (Get-Content $p -Raw -ErrorAction Stop | ConvertFrom-Json) } catch { return $null }
}

Write-Host ''
Write-Host ("moyu 体检 · " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
Write-Host ('-' * 60)

# 1) 状态
$st = ReadJson (Join-Path $Root 'state.json')
if (-not $st) {
  Line 'bad' '状态' 'state.json 读不出来（文件损坏或被占用）' "Get-Content '$Root\state.json' -Raw"
} else {
  $leftTxt = '未开始'
  if ($st.sessionEnds) {
    try {
      $leftMin = [int][math]::Floor(([datetime]$st.sessionEnds - (Get-Date)).TotalMinutes)
      if ($leftMin -lt 0) { $leftTxt = '已结束' } else { $leftTxt = "$leftMin 分钟" }
    } catch { }
  }
  Line 'ok' '状态' ("模式 {0}｜剩余 {1}｜已用 {2}/{3} 元｜续 {4} 次" -f $st.mode, $leftTxt, $st.budgetUsed, $st.budgetYuan, $st.wakeCount)
  if ($st.mode -eq 'moyu' -and $st.sessionEnds) {
    try {
      if ((Get-Date) -ge [datetime]$st.sessionEnds) {
        Line 'warn' '窗口' '已经过了但还写着 moyu —— 下次调用任何 action 会自动退' 'moyu.cmd status'
      }
    } catch { }
  }
  if ($st.mode -ne 'moyu' -and $st.mode -ne 'code') {
    Line 'bad' '模式' ("未知模式：{0}" -f $st.mode) "Get-Content '$Root\state.json' -Raw"
  }
}

# 2) 守夜人进程
$guards = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*guard.mjs*' })
$guardCode = 'Get-CimInstance Win32_Process -Filter "Name=''node.exe''" | Where-Object { $_.CommandLine -like ''*guard.mjs*'' }'
if ($guards.Count -gt 1) {
  Line 'warn' '守夜人' ("有 {0} 个实例（应该 1 个，多开的会抢着投消息）" -f $guards.Count) $guardCode
} elseif ($guards.Count -eq 1) {
  Line 'ok' '守夜人' ("在跑（pid {0}）" -f $guards[0].ProcessId)
} else {
  if ($st -and $st.mode -eq 'moyu') { Line 'bad' '守夜人' '正在摸鱼，但它没在跑（掉线时没人拉，内续也不会来）' 'schtasks /run /tn moyu-guard' }
  else { Line 'ok' '守夜人' '没跑（当前不是摸鱼模式，正常）' }
}

# 3) 计划任务
$taskOut = (schtasks /query /tn moyu-guard /fo list 2>&1 | Out-String)
if ($taskOut -match 'moyu-guard') {
  Line 'ok' '计划任务' 'moyu-guard 存在'
} else {
  Line 'warn' '计划任务' 'moyu-guard 不存在（开机自启和掉线恢复会缺）' 'schtasks /query /tn moyu-guard'
}

# 4) 徽章插件
$badgeDir = Join-Path (Join-Path $DshHome 'plugins') 'dsh-moyu-badge'
$profilePkg = Join-Path $DshHome 'profiles\desktop\package.json'
if (Test-Path $badgeDir) { Line 'ok' '徽章插件' '目录在' }
else { Line 'warn' '徽章插件' '目录不在（不影响摸鱼，只是看不到徽章和退出按钮）' "Test-Path '$badgeDir'" }
if (Test-Path $profilePkg) {
  $pj = ReadJson $profilePkg
  $bundles = @()
  if ($pj -and $pj.dsh -and $pj.dsh.profile -and $pj.dsh.profile.bundles) { $bundles = @($pj.dsh.profile.bundles) }
  if ($bundles -contains 'dsh-moyu-badge') { Line 'ok' '插件挂载' '徽章已挂进 profile bundles' }
  else { Line 'warn' '插件挂载' '徽章没挂进 profile bundles（重启后不会加载）' "Get-Content '$profilePkg' -Raw" }
}

# 5) 守夜人日志
$log = Join-Path $Root 'logs\guard.log'
if (Test-Path $log) {
  $errs = @(Select-String -Path $log -Pattern 'error|failed' | Select-Object -Last 5)
  if ($errs.Count -gt 0) {
    $last = $errs[-1].Line.Trim()
    # 老账不算病：error 一旦写进日志就永远留在那儿，每天报黄灯没人会去看。
    # 拿最新一条的时间跟 guard.mjs 的修改时间比——在改之前，说明是已修版本之前的旧账。
    $stale = $false
    if ($last -match '^\[(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)\]') {
      try {
        $errAt = [datetime]::Parse($matches[1]).ToLocalTime()
        $guardMjs = Join-Path $Root 'guard.mjs'
        if (Test-Path $guardMjs) {
          $fixedAt = (Get-Item $guardMjs).LastWriteTime
          if ($errAt -lt $fixedAt) { $stale = $true }
        }
      } catch {}
    }
    if ($stale) {
      Line 'ok' '守夜人日志' ("最近一条 error 在 guard.mjs 上次修改之前（{0}），改完没再出现" -f $matches[1])
    } else {
      Line 'warn' '守夜人日志' ("有 {0} 条 error/failed，最近一条：{1}" -f $errs.Count, $last) "Select-String -Path '$log' -Pattern 'error|failed' | Select-Object -Last 20"
    }
  } else {
    Line 'ok' '守夜人日志' '没有 error/failed'
  }
  $lastLine = (Get-Content $log -Tail 1) -join ''
  if ($lastLine) { Write-Host ("    最后一行：{0}" -f $lastLine) -ForegroundColor DarkGray }
} else {
  if ($st -and $st.mode -eq 'moyu') { Line 'warn' '守夜人日志' '还没有 guard.log（守夜人从没跑过）' 'schtasks /run /tn moyu-guard' } else { Line 'ok' '守夜人日志' '还没有日志（没进过摸鱼，正常）' }
}

# 6) 规则文件
if (Test-Path (Join-Path $Root 'rules\mode.md')) { Line 'ok' '规则文件' 'rules/mode.md 在' }
else { Line 'bad' '规则文件' 'rules/mode.md 不见了（判定和流程都没地方查）' "Get-ChildItem '$Root\rules'" }

# 6a-1) 游乐场位置（2026-11-17 用户定：挪出 .dsh，受限账号穿不过那一层）
$playDir = Join-Path $env:USERPROFILE 'AkPlay'
if (-not (Test-Path -LiteralPath $playDir)) {
  Line 'bad' '游乐场' ("$playDir 不在（挪过位置？先建目录并授 moyu 写权限）") ('mkdir "' + $playDir + '"; icacls "' + $playDir + '" /grant "moyu:(OI)(CI)M"')
} else {
  $aclTxt = (icacls $playDir 2>&1 | Out-String)
  if ($aclTxt -notmatch 'moyu') {
    Line 'warn' '游乐场' '目录在，但 moyu 没有写权限（跑起来会 EPERM）' ('icacls "' + $playDir + '" /grant "moyu:(OI)(CI)M"')
  } else {
    Line 'ok' '游乐场' ("$playDir 在，moyu 可写（不在 .dsh 里，受限账号穿得进去）")
  }
}

# 6a-1b) 空 node 泄漏 + 提交内存（2026-11-17 崩机的真根因）
#   那天 node.exe 攒到 1061 个，其中 1049 个是「没带脚本参数的空 node」，
#   占掉约 55 GB 提交内存 → 提交可用只剩 0.5 GB → PowerShell 报 0x800705AF(页面文件太小)、
#   DSH 主进程被系统干掉。空 node 的来源是计划任务参数少了一对引号（见下面 6a-1c）。
$bareNode = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object {
    $cl = [string]$_.CommandLine
    if (-not $cl) { return $false }
    $m = [regex]::Match($cl, '(?i)node\.exe"?\s*(.*)$')
    $m.Success -and $m.Groups[1].Value.Trim() -eq ''
})
$commitFreeGB = 0
try {
    $osInfo = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
    $commitFreeGB = [double]$osInfo.FreeVirtualMemory / 1MB
} catch { }
$nodeDetail = ('空 node {0} 个，提交可用 {1:N1} GB' -f $bareNode.Count, $commitFreeGB)
if ($bareNode.Count -gt 50 -or $commitFreeGB -lt 1.5) {
    $pids = ($bareNode | Select-Object -First 5 | ForEach-Object { $_.ProcessId }) -join ','
    Line 'bad' '进程泄漏' ($nodeDetail + '（空 node 太多或内存见底，DSH 可能被系统杀掉）') ('Get-CimInstance Win32_Process -Filter "Name=''node.exe''" | ? { -not $_.CommandLine -or $_.CommandLine -match ''node\.exe"?\s*$'' } | % { Stop-Process -Id $_.ProcessId -Force }   # 先看 pid: ' + $pids)
} elseif ($bareNode.Count -gt 5 -or $commitFreeGB -lt 4) {
    Line 'warn' '进程泄漏' ($nodeDetail + '（有点多，留意是不是又有任务在刷空 node）')
} else {
    Line 'ok' '进程泄漏' ($nodeDetail)
}

# 6a-1c) 计划任务参数引号（2026-11-17 加）
#   hidden-run.exe 只吃「一个」参数：整条命令行必须自己包一对引号。
#   漏了引号的后果不是报错，是后半截被丢掉——比如 Moyu-AutoEnter 原来写成
#   node.exe gate.mjs（两段）→ 实际只跑了 node.exe → 每分钟一个空 node，挂一万年。
$badTasks = @()
$hrTasks = @()
try {
    foreach ($t in (Get-ScheduledTask -ErrorAction Stop)) {
        foreach ($a in $t.Actions) {
            if ([string]$a.Execute -match 'hidden-run') {
                $hrTasks += $t.TaskName
                $ar = [string]$a.Arguments
                if (-not $ar.TrimStart().StartsWith('"') -and $ar -match '\s') {
                    $badTasks += ($t.TaskName + ' :: ' + $ar)
                }
            }
        }
    }
} catch { }
if ($badTasks.Count -gt 0) {
    Line 'bad' '任务参数' ($badTasks.Count.ToString() + ' 个 hidden-run 任务的参数没加引号（后半截会被丢掉）: ' + ($badTasks[0])) '拿 Get-ScheduledTask 看 Arguments，改成 "整条命令" 一个参数，或改成跑一个 .cmd'
} else {
    Line 'ok' '任务参数' ('hidden-run 任务 ' + $hrTasks.Count + ' 个，参数都是整条包好的')
}

# 6a0) 报告自检（2026-11-17 加）：喂一段已知的假记录，核对报告里的数字对不对。
#      为什么：一天里连着发现三处「报告在说谎」（动作数恒 0、退出方式写英文、日记行数读错路径），
#      全是 doctor 报警才看见的。把「已知输入 → 期望数字」钉死，改坏当场红。
$selfTest = Join-Path $Root 'tools\report-selftest.mjs'
if (-not (Test-Path -LiteralPath $selfTest)) {
  Line 'warn' '报告自检' '工具不在（pack 或安装不完整）'
} else {
  $stOut = $null
  try { $stOut = & 'node' $selfTest 2>&1 } catch { $stOut = $null }
  if ($null -eq $stOut) {
    Line 'warn' '报告自检' '跑不起来（node 不在 PATH）'
  } elseif ($LASTEXITCODE -eq 0) {
    Line 'ok' '报告自检' '数字对得上（工具/被拒/程序/桌面/网站/日记/会话七项）'
  } else {
    $firstBad = ($stOut | Where-Object { $_ -match '✗' } | Select-Object -First 1)
    Line 'bad' '报告自检' ("报告的数字和已知记录对不上：" + ($firstBad -replace '^\s*✗\s*', '')) 'node ~/.dsh/moyu/tools/report-selftest.mjs'
  }
}

# 6a1) 退出审计（2026-11-16 用户定）：今天三份记录（sessions.log / 日记 / autonomy 审计）对不对得上
$auditJs = Join-Path $Root 'tools\exit-audit.mjs'
if (-not (Test-Path -LiteralPath $auditJs)) {
  Line 'warn' '退出审计' 'tool 不在（pack 或安装不完整）'
} else {
  $nodeExe = 'node'
  $out = $null
  try { $out = & $nodeExe $auditJs 2>&1 } catch { $out = $null }
  if ($null -eq $out) {
    Line 'warn' '退出审计' '跑不起来（node 不在 PATH）'
  } else {
    $txt = ($out -join "`n")
    if ($LASTEXITCODE -eq 0) {
      Line 'ok' '退出审计' '今天三份对得上'
    } else {
      $firstWarn = ($out | Where-Object { $_ -match '⚠' } | Select-Object -First 1)
      Line 'warn' '退出审计' ("今天对不上：" + ($firstWarn -replace '^s*⚠s*', '')) 'node ~/.dsh/moyu/tools/exit-audit.mjs'
    }
  }
}

# 6a2) 摸鱼日记（2026-11-16 用户报「查看不了摸鱼的日记」）：旧日记被 diary-guard 封了写，
# 但当年用的是 icacls 的 (W,DE)，W 里含 SYNCHRONIZE，导致封完之后连读都读不了。
$diaryDir = Join-Path $Root 'freetime\diary'
if (-not (Test-Path -LiteralPath $diaryDir)) {
  Line 'ok' '摸鱼日记' '还没有 freetime\diary（没写过日记，正常）'
} else {
  $days = @(Get-ChildItem -LiteralPath $diaryDir -File -Filter '*.md' -ErrorAction SilentlyContinue | Sort-Object Name)
  if ($days.Count -eq 0) {
    Line 'ok' '摸鱼日记' '目录在，还没有日记'
  } else {
    $oldest = $days[0]
    $readable = $true
    try { $null = [System.IO.File]::ReadAllText($oldest.FullName) } catch { $readable = $false }
    $badSeal = $false
    try {
      $acl = (Get-Acl -LiteralPath $oldest.FullName).Access
      foreach ($a in $acl) {
        if ($a.AccessControlType -eq 'Deny' -and ($a.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::Synchronize)) { $badSeal = $true }
      }
    } catch {}
    if (-not $readable -or $badSeal) {
      Line 'bad' '摸鱼日记' ("旧日记读不出来（{0}）—— 封印用了带 Synchronize 的拒绝权限，读也被挡住了" -f $oldest.Name) 'diary-guard.cmd -Apply'
    } else {
      Line 'ok' '摸鱼日记' ("{0} 篇，最早 {1} 可读，封印只挡写和删" -f $days.Count, $oldest.BaseName)
    }
  }
}

# 6b) 打包同步（最新 zip vs 源目录，逐字节比；只报不一致，不动任何文件）
# 2026-11-16 起打包不再留 dist\stage-*（暂存在 TEMP 里，打完就删），所以直接读 zip 比。
$zipCandidates = @()
$notebookRoot = Join-Path $env:USERPROFILE 'Desktop\摸鱼笔记'
try {
  $cfgRawD = Get-Content -LiteralPath (Join-Path $Root 'config.json') -Raw -Encoding UTF8 -ErrorAction Stop
  $cfgObjD = $cfgRawD | ConvertFrom-Json
  if ($cfgObjD.notebook -and $cfgObjD.notebook.Trim()) { $notebookRoot = $cfgObjD.notebook.Trim() }
} catch {}
foreach ($d in @((Join-Path $notebookRoot '自建插件\摸鱼模式'), (Join-Path $Root 'dist'))) {
  if (Test-Path -LiteralPath $d) {
    $zipCandidates += @(Get-ChildItem -LiteralPath $d -File -Filter 'dsh-moyu-*.zip' -ErrorAction SilentlyContinue)
  }
}
if ($zipCandidates.Count -eq 0) {
  Line 'ok' '打包同步' '还没打过包（从别人那拿 zip 装的人不需要）'
} else {
  $zip = $zipCandidates | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  $diff = New-Object System.Collections.ArrayList
  $missing = New-Object System.Collections.ArrayList
  $pkgCount = 0
  try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction Stop
    $za = [System.IO.Compression.ZipFile]::OpenRead($zip.FullName)
    try {
      foreach ($e in $za.Entries) {
        if ([string]::IsNullOrEmpty($e.Name)) { continue }
        $rel = $e.FullName -replace '/', '\'
        if (-not $rel.StartsWith('moyu\')) { continue }   # 只比摸鱼侧；插件目录走自己的仓库流程
        $sub = $rel.Substring(5)
        $src = Join-Path $Root $sub
        if (-not (Test-Path -LiteralPath $src)) { $null = $missing.Add($sub); continue }
        $pkgCount++
        $sr = $e.Open()
        $ms = New-Object System.IO.MemoryStream
        $sr.CopyTo($ms)
        $sr.Dispose()
        $bytes = $ms.ToArray()
        $ms.Dispose()
        $disk = [System.IO.File]::ReadAllBytes($src)
        if ($bytes.Length -ne $disk.Length) { $null = $diff.Add($sub); continue }
        $same = $true
        for ($i = 0; $i -lt $bytes.Length; $i++) { if ($bytes[$i] -ne $disk[$i]) { $same = $false; break } }
        if (-not $same) { $null = $diff.Add($sub) }
      }
    } finally { $za.Dispose() }
  } catch {
    Line 'warn' '打包同步' ("读 zip 失败：" + $_.Exception.Message) 'pack.cmd'
  }
  if ($diff.Count -eq 0 -and $missing.Count -eq 0) {
    Line 'ok' '打包同步' ("与 {0} 完全一致（{1} 个文件）" -f $zip.Name, $pkgCount)
  } else {
    $parts = @()
    if ($diff.Count -gt 0) {
      $shown = (@($diff) | Select-Object -First 5) -join '、'
      $parts += ("{0} 个内容不一致：{1}" -f $diff.Count, $shown)
    }
    if ($missing.Count -gt 0) { $parts += ("{0} 个包里文件源里没有" -f $missing.Count) }
    Line 'warn' '打包同步' (("{0} 与源码不同步 —— " -f $zip.Name) + ($parts -join '；')) 'pack.cmd'
  }
}

# 7) 安全锁（ACL）
$aclRec = Join-Path $Root 'state\acl.json'
if (Test-Path $aclRec) {
  $acl = ReadJson $aclRec
  $cnt = 0
  if ($acl -and $acl.paths) { $cnt = @($acl.paths).Count }
  if ($st -and $st.mode -eq 'moyu') {
    Line 'ok' '安全锁' ("生效中（{0} 个路径，摸鱼期间正常）" -f $cnt)
  } else {
    Line 'warn' '安全锁' ("有残留锁（{0} 个路径），但现在不是摸鱼 —— 会把下次 DSH 更新挡住" -f $cnt) 'acl.cmd unlock-safe'
  }
} else {
  Line 'ok' '安全锁' '没有锁'
}

# 8) 续的设置
$cfg = ReadJson (Join-Path $Root 'config.json')
if (-not $cfg) { $cfg = ReadJson (Join-Path $Root 'config.default.json') }   # 干净安装只有 default，别报成缺配置
if ($cfg -and $cfg.wake) {
  $mc = [int]$cfg.wake.maxCount
  $mcTxt = if ($mc -eq 0) { '不限' } else { "整晚最多 $mc 次" }
  Line 'ok' '续' ("间隔 {0} 分钟｜{1}" -f $cfg.wake.intervalMinutes, $mcTxt)
} else {
  if ($cfg) { Line 'ok' '续' '用 config.default.json 的默认值' } else { Line 'warn' '续' 'config.json / config.default.json 都读不出来，用内置默认值' "Get-Content '$Root\config.json' -Raw" }
}

# 9) 拒绝权
if ($cfg -and $cfg.rejection) {
  $mode = $cfg.rejection.mode
  $modeTxt = '有活就干'
  if ($mode -eq 'deny') { $modeTxt = '一律拒' }
  elseif ($mode -eq 'judge') { $modeTxt = '按人设与记忆判断' }
  Line 'ok' '拒绝权' ("{0}（{1}）" -f $modeTxt, $mode)
} else {
  if ($cfg) { Line 'ok' '拒绝权' '没有 rejection 段，按「有活就干」' } else { Line 'warn' '拒绝权' 'config 读不出来，按「有活就干」处理' }
}

# 10) 用量脚本（预算靠它，读不到就等于没有预算）
$nodeExe = 'node'
$np = Join-Path $Root 'node-path.txt'
if (Test-Path $np) {
  $cand = (Get-Content $np -Raw).Trim()
  if ($cand -and (Test-Path $cand)) { $nodeExe = $cand }
}
$usagePath = Join-Path $Root 'usage.mjs'
if (-not (Test-Path $usagePath)) {
  Line 'warn' '用量脚本' 'usage.mjs 不见了 —— 预算只能靠手记' "Get-ChildItem '$Root\*.mjs'"
} else {
  $usageOk = $false
  $usageDetail = ''
  try {
    $out = (& $nodeExe $usagePath snapshot 2>&1 | Out-String).Trim()
    if ($out.StartsWith('{')) {
      $uj = $out | ConvertFrom-Json
      if ($uj -and $uj.sessionId -ne $null -and $uj.totalTokens -ne $null) {
        $usageOk = $true
        $usageDetail = ("读到累计 {0:N0} token（本会话）" -f [double]$uj.totalTokens)
      }
    } else {
      $usageDetail = ($out -split "`n")[0]
    }
  } catch {
    $usageDetail = $_.Exception.Message
  }
  if ($usageOk) { Line 'ok' '用量脚本' $usageDetail }
  else {
    Line 'warn' '用量脚本' ("读不到用量（{0}）—— 预算这轮算不了，多半是 DSH 升级改了内部结构" -f $usageDetail) "& '$nodeExe' '$usagePath' snapshot"
  }
}

# 11) 到点兜底任务
$hasExitTask = $false
try {
  # 不能拿输出里有没有 "moyu-exit" 判断：任务不存在时，报错原文里也带着这个名字。
  # 只看退出码。
  $null = schtasks /query /tn moyu-exit /fo list 2>&1
  $hasExitTask = ($LASTEXITCODE -eq 0)
} catch { }
if ($st -and $st.mode -eq 'moyu') {
  if ($hasExitTask) { Line 'ok' '到点兜底' 'moyu-exit 任务在（守夜人死了也会退）' }
  else { Line 'warn' '到点兜底' '正在摸鱼却没有 moyu-exit 任务 —— 守夜人一死就到点不退' 'moyu.cmd exit; 然后重新 moyu.cmd enter' }
} else {
  if ($hasExitTask) { Line 'warn' '到点兜底' '不在摸鱼却有残留的 moyu-exit 任务（下次可能提前退）' 'schtasks /delete /tn moyu-exit /f' }
  else { Line 'ok' '到点兜底' '没有残留任务' }
}

# L3：受限账号 moyu（跑 = 地盘时，命令以这个账号执行，写不到地盘外、也出不了网）
try {
  $mu = Get-LocalUser -Name 'moyu' -ErrorAction SilentlyContinue
  if (-not $mu) {
    Line 'warn' 'L3 账号' '没有 moyu 账号，地盘的「user」形同虚设，命令仍以管理员身份跑' 'powershell -NoProfile -ExecutionPolicy Bypass -File \'$Root\install-l3.ps1\''
  } else {
    $secFile = Join-Path $Root 'secrets\moyu-account.json'
    $aclTxt = ''
    if (Test-Path -LiteralPath $secFile) { $aclTxt = (icacls $secFile | Out-String) }
    if (-not $aclTxt) {
      Line 'bad' 'L3 账号' "账号在，但密码文件不见了：$secFile" 'powershell -NoProfile -ExecutionPolicy Bypass -File \'$Root\install-l3.ps1\''
    } elseif ($aclTxt -match 'moyu:') {
      Line 'bad' 'L3 账号' '密码文件对 moyu 账号可读 —— 等于把提权钥匙交给了笼子里的进程' "icacls '$secFile' /inheritance:r /grant:r 'BUILTIN\Administrators:(F)' 'NT AUTHORITY\SYSTEM:(F)'"
    } else {
      $prog = Join-Path $Root 'l3-programs.json'
      $hasProg = Test-Path -LiteralPath $prog
      $fw = Get-NetFirewallRule -DisplayName 'Ak Moyu-NoNet' -ErrorAction SilentlyContinue
      $prof = Get-NetFirewallProfile -Name Public -ErrorAction SilentlyContinue
      $fwOn = ($fw -and $fw.Enabled -eq 'True')
      $pubOn = ($prof -and $prof.Enabled -eq 'True')
      if ($fwOn -and $pubOn) {
        Line 'ok' 'L3 账号' ("账号在｜密码文件只管理员可读｜出站全阻规则生效" + $(if ($hasProg) { '｜程序表在' } else { '｜程序表缺 l3-programs.json' }))
      } elseif ($fwOn -and -not $pubOn) {
        Line 'warn' 'L3 账号' '出站全阻规则在，但「公用网络」档防火墙是关的 —— 规则不生效' 'Set-NetFirewallProfile -Name Public -Enabled True'
      } else {
        Line 'warn' 'L3 账号' '没有出站全阻规则，moyu 账号能上网' "New-NetFirewallRule -DisplayName 'Ak Moyu-NoNet' -Direction Outbound -Action Block -LocalUser 'D:(A;;CC;;;' + $mu.SID.Value + ')' -Profile Any"
      }
    }
  }
} catch { Line 'warn' 'L3 账号' ("检查时出错：" + $_.Exception.Message) }

# 地盘名单：每块都必须写 user: moyu（不写就等于用管理员跑），runPaths 里的程序必须真实存在
try {
  $cfgPath = Join-Path $Root 'config.json'
  if (Test-Path $cfgPath) {
    $cfgText = [System.IO.File]::ReadAllText($cfgPath, [System.Text.Encoding]::UTF8)
    $cfgObj = $cfgText | ConvertFrom-Json
    $noUser = @()
    $missPath = @()
    if ($cfgObj.scopes) {
      foreach ($p in $cfgObj.scopes.PSObject.Properties) {
        $sc = $p.Value
        if ($sc.user -ne 'moyu') { $noUser += $p.Name }
        if ($sc.runPaths) {
          foreach ($rp in $sc.runPaths) { if (-not (Test-Path -LiteralPath $rp)) { $missPath += $rp } }
        }
      }
    }
    if ($noUser.Count -gt 0) {
      Line 'bad' '地盘名单' ("这些地盘没写 user: moyu，等于用管理员跑：" + ($noUser -join ' / ')) '照边界模板.md 给每块地盘补 "user": "moyu"'
    } elseif ($missPath.Count -gt 0) {
      Line 'warn' '地盘名单' ("有程序路径不存在（起不来）：" + ($missPath -join ' / ')) '改 config.json 里对应地盘的 runPaths'
    } else {
      $cnt = 0
      if ($cfgObj.scopes) { $cnt = @($cfgObj.scopes.PSObject.Properties).Count }
      Line 'ok' '地盘名单' ("每块都写了 user: moyu，runPaths 都在｜共 $cnt 块") ''
    }
  } else {
    Line 'warn' '地盘名单' '没有 config.json，读不到地盘' '放进 ~/.dsh/moyu/config.json'
  }
} catch { Line 'warn' '地盘名单' ("检查时出错：" + $_.Exception.Message) '' }

# ---------- 依赖与前置（-Fix 能自动补；补不了的把命令打出来） ----------
function AddFix($key, $fixScript) { $script:fixOps[$key] = $fixScript }
$stub = { param($m) Write-Host ("    跳过：{0}" -f $m) }

# 管理员权限
$isAdmin = $false
try {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $isAdmin = (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
} catch {}
if ($isAdmin) { Line 'ok' '管理员权限' '当前是管理员，建账号 / 改 ACL / 改防火墙都能做' }
else { Line 'bad' '管理员权限' '不是管理员：账号、ACL、防火墙这一步做不了。关掉 DSH，右键用「以管理员身份运行」再开' 'whoami /groups | findstr S-1-5-32-544' }

# 浏览器（可选功能：只给 AI 浏览器用；没有也能跑，web_fetch 不受影响）
$browserCandidates = @(
  'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
  'C:\Program Files\Microsoft\Edge\Application\msedge.exe',
  'C:\Program Files\Google\Chrome\Application\chrome.exe',
  'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe'
)
$browserExe = $null
foreach ($b in $browserCandidates) { if (Test-Path -LiteralPath $b) { $browserExe = $b; break } }
if ($browserExe) { Line 'ok' '浏览器' ('在：' + $browserExe + '（AI 浏览器用它）') }
else { Line 'ok' '浏览器' '没装 Edge/Chrome —— 可选功能：AI 浏览器用不了，web_fetch / web_search 照常' }

# hidden-run.exe（隐藏窗口 + 脱离作业对象）
$runner = 'C:\NapCat\hidden-run.exe'
if (Test-Path -LiteralPath $runner) { Line 'ok' '隐藏启动器' 'hidden-run.exe 在（计划任务不弹窗、浏览器能脱离作业对象）' }
else {
  $srcCs = 'C:\NapCat\hidden-run.cs'
  Line 'ok' '隐藏启动器' '没有 hidden-run.exe —— 能跑，只是计划任务会闪一下黑框、AI 浏览器可能被作业对象连坐'
  if (Test-Path -LiteralPath $srcCs) { Write-Host '    （有 hidden-run.cs，跑 -Fix 可以自动编译）' }
  if (Test-Path -LiteralPath $srcCs) {
    AddFix 'hidden-run' {
      $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
      if (Test-Path -LiteralPath $csc) {
        & $csc /nologo /target:exe "/out:$runner" $srcCs | Out-Null
        Write-Host ("    编译好了：{0}" -f $runner)
      } else { Write-Host '    找不到 csc.exe，手动编译一下 hidden-run.cs' }
    }
  }
}

# node 运行环境：优先用 bin\node.exe 副本；没有就用 Electron 本体当 node（ELECTRON_RUN_AS_NODE=1）
$moyuNode = Join-Path $Root 'bin\node.exe'
$appExe = 'E:\dsh\DeepSeek Harness.exe'
$electronAsNode = $false
if (Test-Path -LiteralPath $appExe) {
  try {
    $env:ELECTRON_RUN_AS_NODE = '1'
    $probe = (& $appExe -e "console.log(process.version)" 2>$null | Out-String).Trim()
    if ($probe -match '^v\d') { $electronAsNode = $true }
  } catch {} finally { Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue }
}
# 2026-11-17：第三种合法形态——「原地授权」：直接给 moyu 读执行权限，不复制副本
$inPlaceNode = ''
$l3map = Join-Path $Root 'l3-programs.json'
if (Test-Path -LiteralPath $l3map) {
  try {
    $lm = ([System.IO.File]::ReadAllText($l3map, [System.Text.Encoding]::UTF8) | ConvertFrom-Json)
    if ($lm.node -and (Test-Path -LiteralPath $lm.node) -and ($lm.node -notlike "*\moyu\bin\*")) { $inPlaceNode = $lm.node }
  } catch {}
}
if (-not $inPlaceNode) {
  $npTxt = Join-Path $Root 'node-path.txt'
  if (Test-Path -LiteralPath $npTxt) {
    $cand = ([System.IO.File]::ReadAllText($npTxt, [System.Text.Encoding]::UTF8)).Trim()
    if ($cand -and (Test-Path -LiteralPath $cand)) { $inPlaceNode = $cand }
  }
}
$moyuAcl = ''
if ($inPlaceNode) {
  $moyuAcl = (& icacls $inPlaceNode 2>&1 | Out-String)
}
if (Test-Path -LiteralPath $moyuNode) { Line 'ok' 'node 运行环境' 'bin\node.exe 在（moyu 账号也有执行权限）' }
elseif ($inPlaceNode -and ($moyuAcl -match 'moyu')) { Line 'ok' 'node 运行环境' ("原地授权：" + $inPlaceNode + "（没复制副本）") }
elseif ($electronAsNode) { Line 'ok' 'node 运行环境' '用 DSH 自带的 Electron 当 node（不用复制副本；地盘的 node/python 需要时再跑 -Fix 补副本）' }
else {
  Line 'warn' 'node 运行环境' '既没有 bin\node.exe，Electron 也不能当 node 用' 'Get-ChildItem "$env:USERPROFILE\.dsh\moyu\bin"'
  AddFix 'node' {
    $sys = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
    if (-not $sys) { $sys = $env:DSH_NODE }
    if (-not $sys -or -not (Test-Path -LiteralPath $sys)) { Write-Host '    这台机器 PATH 里没有 node，DSH_NODE 也没有'; return }
    # 先试原地授权（省掉一份副本）；不成再复制
    & icacls (Split-Path -Parent $sys) /grant 'moyu:(OI)(CI)RX' 2>&1 | Out-Null
    & icacls $sys /grant 'moyu:(RX)' 2>&1 | Out-Null
    Write-Host ("    已给 moyu 授 {0} 的读执行权限（没复制副本）" -f $sys)
  }
}

# python（可选，跑小程序用）
$pyCmd = (Get-Command python.exe -ErrorAction SilentlyContinue).Source
if ($pyCmd) { Line 'ok' 'python' ("在：" + $pyCmd) }
else { Line 'ok' 'python' '没有 python —— 可选：地盘的「能起 python」用不了（只用 node 的话不用管）' }

# 浏览器账号 akweb + 密码文件 + 出站封本机规则
$web = Get-LocalUser -Name 'akweb' -ErrorAction SilentlyContinue
$webSec = Join-Path $Root 'secrets\web-account.json'
if (-not $web) {
  Line 'ok' '浏览器账号' '没有 akweb 账号 —— 可选：只是「起浏览器」用不了' 'powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.dsh\moyu\install-web.ps1"'
  AddFix 'akweb' { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'install-web.ps1') }
} elseif (-not (Test-Path -LiteralPath $webSec)) {
  Line 'ok' '浏览器账号' '账号在，但密码文件不见了（secrets\web-account.json）—— 可选功能受影响' 'powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.dsh\moyu\install-web.ps1"'
  AddFix 'akweb-sec' { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'install-web.ps1') }
} else {
  $webFw = Get-NetFirewallRule -DisplayName 'Ak Web-NoLocal' -ErrorAction SilentlyContinue
  if ($webFw -and $webFw.Enabled -eq 'True') { Line 'ok' '浏览器账号' 'akweb 在｜密码文件在｜出站封本机规则生效' }
  else {
    Line 'warn' '浏览器账号' 'akweb 在，但没有「出站封本机/局域网」规则 —— 浏览器能摸到 127.0.0.1（这条是真风险，建议 -Fix）' 'Get-NetFirewallRule -DisplayName "Ak Web-NoLocal"'
    AddFix 'akweb-fw' { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'install-web.ps1') }
  }
}

# 下载投递箱
$inboxDir = 'C:\Users\akweb\Downloads\ak-inbox'
if (Test-Path -LiteralPath $inboxDir) { Line 'ok' '下载投递箱' 'C:\Users\akweb\Downloads\ak-inbox 在' }
else {
  Line 'warn' '下载投递箱' '目录不存在：CDP 设下载路径会失败，下载直接没影' 'Test-Path C:\Users\akweb\Downloads\ak-inbox'
  AddFix 'inbox' {
    New-Item -ItemType Directory -Force -Path $inboxDir | Out-Null
    & icacls $inboxDir /grant 'akweb:(OI)(CI)M' 2>&1 | Out-Null
    Write-Host '    建好了，akweb 可写'
  }
}

# 关键脚本齐不齐
$needFiles = @('run-as.ps1', 'run-web.ps1', 'web-proxy.mjs', 'web-cdp.mjs', 'install-l3.ps1', 'install-web.ps1', 'guard.mjs', 'moyu.ps1', 'grant.mjs', 'gate.mjs')
$missFiles = @($needFiles | Where-Object { -not (Test-Path -LiteralPath (Join-Path $Root $_)) })
if ($missFiles.Count -eq 0) { Line 'ok' '关键脚本' ("{0} 个都在" -f $needFiles.Count) }
else { Line 'bad' '关键脚本' ("缺 {0} 个：{1} —— 重装 zip 最省事" -f $missFiles.Count, ($missFiles -join '、')) 'Get-ChildItem "$env:USERPROFILE\.dsh\moyu"' }

# 磁盘
$freeGB = $null
try { $freeGB = [math]::Round((Get-PSDrive -Name C -ErrorAction Stop).Free / 1GB, 1) } catch {}
if ($freeGB -ne $null) {
  if ($freeGB -lt 3) { Line 'warn' '磁盘' ("C 盘只剩 {0} GB —— 摸鱼前会卡在预检（低于 3GB 就不进）" -f $freeGB) 'Get-PSDrive C' }
  else { Line 'ok' '磁盘' ("C 盘剩 {0} GB" -f $freeGB) }
}
if ($Fix -and $script:fixOps.Count -gt 0) {
  Write-Host ''
  Write-Host ('=' * 60)
  Write-Host ("开始补齐（{0} 项）：只动账号、密码文件、ACL、防火墙规则、目录、node 副本、启动器" -f $script:fixOps.Count)
  foreach ($k in @($script:fixOps.Keys)) {
    Write-Host ("→ {0}" -f $k)
    try { & $script:fixOps[$k] } catch { Write-Host ("    补的时候出错：{0}" -f $_.Exception.Message) }
  }
  Write-Host ''
  Write-Host '--- 补齐后复查 ---'
  & $PSCommandPath -Root $Root
  exit $LASTEXITCODE
}
Write-Host ('-' * 60)
$lines = New-Object System.Collections.ArrayList
$null = $lines.Add('=== moyu 体检报告（整段复制，发给你自己那边的 AI）===')
$null = $lines.Add(("时间 {0}｜机器 {1}｜moyu {2}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $env:COMPUTERNAME, $Root))
foreach ($r in $script:rows) {
  $m = '✓'
  if ($r.level -eq 'warn') { $m = '!' } elseif ($r.level -eq 'bad') { $m = '✗' }
  $null = $lines.Add(("{0} {1} — {2}" -f $m, $r.name, $r.detail))
  if ($r.code -and $r.level -ne 'ok') { $null = $lines.Add('    代码：' + $r.code) }
}
$null = $lines.Add(("结果：{0} 正常 / {1} 警告 / {2} 失败" -f $script:okN, $script:warnN, $script:badN))
$null = $lines.Add('=== 报告结束 ===')
$txt = ($lines -join "`r`n")
if ($script:warnN -eq 0 -and $script:badN -eq 0 -and -not $Report) { $txt = '' }
if ($txt) { Write-Host $txt -ForegroundColor DarkGray }
if ($Report) {
  try {
    [System.IO.File]::WriteAllText($Report, $txt, (New-Object System.Text.UTF8Encoding($true)))
    Write-Host ("报告已写到 {0}" -f $Report)
  } catch { Write-Host ("报告写不进去：{0}" -f $_.Exception.Message) }
}
Write-Host ('-' * 60)
Write-Host ("结果：{0} 项正常，{1} 项警告，{2} 项失败" -f $script:okN, $script:warnN, $script:badN)
if ($script:badN -gt 0) {
  Write-Host '有失败项，按上面的「代码」逐条排查。'
  exit 2
}
if ($script:warnN -gt 0) {
  Write-Host '有警告，多数不影响使用，看一眼就行。'
  exit 1
}
Write-Host '全部正常。'
exit 0
﻿﻿﻿﻿# install-l3.ps1 —— 装/修 L3（受限账号 moyu = 摸鱼账号）
# 【称呼对照】本机有两个受限账号，名字是英文，意思在这里：
#   moyu  = 摸鱼账号：能写 playground 与 freetime，不出网；摸鱼时跑小程序用它。
#   akweb = 浏览器账号：能上网，碰不到用户目录；AI 浏览器以它的身份运行。
# 装什么：
#   1. 本地标准账号 moyu（随机密码，只写进 secrets\moyu-account.json，且该文件只管理员可读）
#   2. 只给 playground 与 freetime 两块目录「修改」权限（其余目录默认就写不进）
#   3. 一份 moyu 能读能执行的 node（复制到 moyu\bin），以及 python 的读执行权限
#   4. 防火墙「该账号一律不许出网」规则（用户级 + SDDL）
# 跑法：powershell -NoProfile -ExecutionPolicy Bypass -File install-l3.ps1
param([string]$Root = '')

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
if ([string]::IsNullOrWhiteSpace($Root)) { $Root = $PSScriptRoot }
$secDir = Join-Path $Root 'secrets'
$secFile = Join-Path $secDir 'moyu-account.json'
$binDir = Join-Path $Root 'bin'

function Say($s) { Write-Host $s }

# ── 1. 账号 ─────────────────────────────────────────────
$u = Get-LocalUser -Name 'moyu' -ErrorAction SilentlyContinue
if (-not $u) {
  $pw = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 28 | ForEach-Object { [char]$_ })
  $sec = ConvertTo-SecureString $pw -AsPlainText -Force
  New-LocalUser -Name 'moyu' -Password $sec -PasswordNeverExpires `
    -Description 'DSH 摸鱼受限账号（L3）' -UserMayNotChangePassword | Out-Null
  New-Item -ItemType Directory -Force -Path $secDir | Out-Null
  @{ username = 'moyu'; password = $pw; created = (Get-Date).ToString('s') } |
    ConvertTo-Json | Set-Content -LiteralPath $secFile -Encoding utf8
  Say '✓ 账号 moyu 已创建，密码写进 secrets\moyu-account.json'
} else {
  if (-not (Test-Path -LiteralPath $secFile)) {
    throw '账号 moyu 已存在但没有密码文件，没法以它身份起进程。先 Remove-LocalUser moyu 再重跑本脚本。'
  }
  Say '✓ 账号 moyu 已存在'
}
$sid = (Get-LocalUser -Name 'moyu').SID.Value

# 密码文件：只管理员和 SYSTEM 可读（moyu 读不到，读到就等于能提权）
icacls $secDir /inheritance:r /grant:r 'BUILTIN\Administrators:(OI)(CI)F' 'NT AUTHORITY\SYSTEM:(OI)(CI)F' | Out-Null
icacls $secFile /inheritance:r /grant:r 'BUILTIN\Administrators:(F)' 'NT AUTHORITY\SYSTEM:(F)' | Out-Null
Say '✓ 密码文件权限：只有 Administrators / SYSTEM'

# ── 2. 两块可写目录 ─────────────────────────────────────
foreach ($d in @((Join-Path $DshHome 'playground'), (Join-Path $Root 'freetime'))) {
  if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
  icacls $d /grant:r "moyu:(OI)(CI)M" | Out-Null
}
Say '✓ 可写目录：playground / freetime（其余写不进）'

# ── 3. 程序 ────────────────────────────────────────────
# 2026-11-17：优先「原地授权」，不再复制 node.exe 副本（少一个缺项、少一份要维护的文件）。
# 授权后还要以 moyu 身份真跑一次；跑不起来才退回复制。
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
$nodeSrc = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodeSrc) { $nodeSrc = $env:DSH_NODE }
if (-not $nodeSrc -or -not (Test-Path -LiteralPath $nodeSrc)) {
  throw '找不到 node.exe：PATH 里没有，DSH_NODE 也没有'
}
$nodeUse = ''
$nodeSrcDir = Split-Path -Parent $nodeSrc
& icacls $nodeSrcDir /grant "moyu:(OI)(CI)RX" 2>&1 | Out-Null
& icacls $nodeSrc /grant "moyu:(RX)" 2>&1 | Out-Null
$probeJson = Join-Path $Root 'freetime\node-probe.json'
$probeBase = Join-Path $Root 'freetime\node-probe'
try {
  [System.IO.File]::WriteAllText($probeJson, '["-e","console.log(''ok'')"]', (New-Object System.Text.UTF8Encoding($false)))
  $probeOut = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'run-as.ps1') -Exe $nodeSrc -ArgsJson $probeJson -Cwd $binDir -TimeoutSec 30 -OutBase $probeBase 2>&1
  if ($LASTEXITCODE -eq 0 -and (Test-Path ($probeBase + '.out')) -and ((Get-Content ($probeBase + '.out') -Raw) -match 'ok')) { $nodeUse = $nodeSrc }
} catch {} finally {
  Remove-Item -LiteralPath $probeJson, ($probeBase + '.out'), ($probeBase + '.err'), ($probeBase + '.cmd'), ($probeBase + '.pid') -ErrorAction SilentlyContinue
}
if ($nodeUse) {
  Say ("✓ node 原地授权：{0}（没有复制副本）" -f $nodeSrc)
} else {
  Copy-Item -LiteralPath $nodeSrc -Destination (Join-Path $binDir 'node.exe') -Force
  & icacls $binDir /grant:r "moyu:(OI)(CI)RX" 2>&1 | Out-Null
  $nodeUse = Join-Path $binDir 'node.exe'
  Say ("! 原地授权后 moyu 跑不起来，已退回复制：{0}" -f $nodeUse)
}

$pySrc = (Get-Command python -ErrorAction SilentlyContinue).Source
if ($pySrc) {
  $pyDir = Split-Path -Parent $pySrc
  icacls $pyDir /grant:r "moyu:(OI)(CI)RX" | Out-Null
  Say "✓ python 读执行权限：$pyDir"
} else {
  $pySrc = ''
  Say '! 没找到 python，地盘的 python/py 会起不来'
}

$map = @{ node = $nodeUse }
if ($pySrc) { $map['python'] = $pySrc; $map['py'] = $pySrc }
[System.IO.File]::WriteAllText((Join-Path $Root 'l3-programs.json'), ($map | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
Say '✓ 程序表：l3-programs.json'

# ── 4. 防火墙：该账号一律不许出网 ──────────────────────
$ruleName = 'Ak Moyu-NoNet'
Remove-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName $ruleName -Direction Outbound -Action Block `
  -LocalUser ("D:(A;;CC;;;$sid)") -Profile Any `
  -Description 'DSH 摸鱼受限账号：一律不许出网' | Out-Null
Say '✓ 防火墙：moyu 出站全阻'

$pub = Get-NetFirewallProfile -Name Public -ErrorAction SilentlyContinue
if ($pub -and $pub.Enabled -eq 'False') {
  Say '! 「公用网络」档防火墙是关的 —— 上面那条规则不会生效'
  Say '  开：Set-NetFirewallProfile -Name Public -Enabled True'
}

# ── 5. 自检 ────────────────────────────────────────────
$probeBase = Join-Path (Join-Path $DshHome 'playground') 'l3-selftest'
try {
  $pw2 = (Get-Content -LiteralPath $secFile -Raw | ConvertFrom-Json).password
  $cred = New-Object System.Management.Automation.PSCredential('moyu', (ConvertTo-SecureString $pw2 -AsPlainText -Force))
  $t = 'C:\Users\Public\l3-selftest.ps1'
  @'
$n = 'C:\Users\Administrator\.dsh\moyu\bin\node.exe'
if (-not (Test-Path $n)) { $n = (Get-Content 'C:\Users\Administrator\.dsh\moyu\l3-programs.json' -Raw | ConvertFrom-Json).node }
$u = & $n -e "process.stdout.write(require('os').userInfo().username)" 2>&1
$u | Out-File 'C:\Users\Administrator\.dsh\playground\l3-selftest.out' -Encoding utf8
'@ | Set-Content -LiteralPath $t -Encoding utf8
  $p = Start-Process powershell -Credential $cred -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $t `
    -WorkingDirectory 'C:\Users\Public' -Wait -PassThru -WindowStyle Hidden
  $got = (Get-Content (Join-Path $DshHome 'playground\l3-selftest.out') -Raw -ErrorAction SilentlyContinue)
  if ($got -and $got.Trim() -eq 'moyu') { Say '✓ 自检：能以 moyu 身份起 node' }
  else { Say '! 自检没过：起 node 时没拿到 moyu 身份，看看 l3-programs.json 指的程序在不在' }
} catch {
  Say ('! 自检出错：' + $_.Exception.Message)
} finally {
  Remove-Item (Join-Path $DshHome 'playground\l3-selftest.out') -ErrorAction SilentlyContinue
  Remove-Item 'C:\Users\Public\l3-selftest.ps1' -ErrorAction SilentlyContinue
}

Say ''
Say '装完了。跑 = 地盘时，命令就在这个账号里执行：写不到地盘外、一律出不了网。'
exit 0

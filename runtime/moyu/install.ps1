# moyu install.ps1 -- 一次性安装/校准脚本
#
# 用法（在本目录下）：
#     powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
#
# 它做四件事：
#   1. 找到 node.exe，把绝对路径写进 node-path.txt
#   2. 检查关键文件在不在
#   3. 注册（或校正）计划任务 moyu-guard
#   4. 跑一遍 doctor.ps1
#
# 找不到 node 时明确告诉你怎么设，而不是静默失败。

param([switch]$Quiet)

$ErrorActionPreference = 'Continue'
$DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$Root = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }

function Say($s) { if (-not $Quiet) { Write-Host $s } }

Say ''
Say '=== moyu install ==='

# ---------- 1. node ----------
$candidates = @()
if ($env:DSH_NODE) { $candidates += $env:DSH_NODE }
try {
  $w = & where.exe node.exe 2>$null
  if ($w) { $candidates += (($w | Select-Object -First 1) -as [string]).Trim() }
} catch {}
$candidates += (Join-Path $DshHome 'dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe')

$node = $null
foreach ($c in $candidates) {
  if ($c -and (Test-Path -LiteralPath $c)) { $node = $c; break }
}

if (-not $node) {
  Say ''
  Say '[!!] 找不到 node.exe'
  Say '     试过：%DSH_NODE% / PATH / %USERPROFILE%\.dsh\dsh-runtimes\...'
  Say '     请设置环境变量 DSH_NODE 指向 node.exe，然后重跑本脚本：'
  Say '         setx DSH_NODE "C:\path\to\node.exe"'
  Say ''
  exit 1
}

[IO.File]::WriteAllText((Join-Path $Root 'node-path.txt'), $node, [Text.UTF8Encoding]::new($false))
Say "[OK]   node -> $node"

# ---------- 2. files ----------
$need = @('guard.mjs', 'guard-hidden.vbs', 'moyu.ps1', 'guard.cmd', 'rules\mode.md')
$missing = @()
foreach ($f in $need) {
  if (-not (Test-Path -LiteralPath (Join-Path $Root $f))) { $missing += $f }
}
if ($missing.Count) {
  Say "[FAIL] 缺文件：$($missing -join ', ')"
  exit 1
}
Say '[OK]   文件齐全'

# ---------- 2.5 DSH 程序路径（写进 config.json 的 paths.protected） ----------
# 别的机器上 DSH 装在哪不一定，所以不写死：先看正在运行的进程，再看两个常见目录。
$cfgPath = Join-Path $Root 'config.json'
if (Test-Path -LiteralPath $cfgPath) {
  $hints = @()
  $proc = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like '*Harness*' } | Select-Object -First 1
  if ($proc -and $proc.Path) { $hints += (Split-Path -Parent $proc.Path) }
  $hints += (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness')
  $hints += 'C:\Program Files\DeepSeek Harness'
  $found = @()
  foreach ($h in ($hints | Select-Object -Unique)) {
    if (-not $h -or -not (Test-Path -LiteralPath $h)) { continue }
    foreach ($rel in @('DeepSeek Harness.exe', 'resources\app.asar', 'Uninstall DeepSeek Harness.exe', 'resources\app-update.yml')) {
      $full = Join-Path $h $rel
      if (Test-Path -LiteralPath $full) { $found += $full }
    }
    if ($found.Count) { break }
  }
  if ($found.Count) {
    try {
      $cfg = Get-Content -LiteralPath $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
      if (-not $cfg.paths) { $cfg | Add-Member -NotePropertyName paths -NotePropertyValue ([pscustomobject]@{}) -Force }
      $existing = @()
      if ($cfg.paths.PSObject.Properties.Name -contains 'protected') { $existing = @($cfg.paths.protected) }
      $merged = @(@($existing) + @($found) | Select-Object -Unique)
      $cfg.paths | Add-Member -NotePropertyName protected -NotePropertyValue $merged -Force
      [IO.File]::WriteAllText($cfgPath, ($cfg | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
      Say ("[OK]   安全锁覆盖 DSH 程序：{0} 个路径" -f $found.Count)
    } catch {
      Say "[WARN] 写 config.json 失败：$($_.Exception.Message)"
    }
  } else {
    Say '[WARN] 没找到 DSH 安装目录，安全锁只锁摸鱼插件自身（不影响使用）'
  }
}

# ---------- 3. scheduled task ----------
$taskName = 'moyu-guard'
$guardVbs = Join-Path $Root 'guard-hidden.vbs'
try {
  $action   = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + $guardVbs + '"')
  $trigger  = New-ScheduledTaskTrigger -Once -At (Get-Date)
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
  $null = Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force
  Say "[OK]   计划任务 $taskName"
} catch {
  Say "[WARN] 计划任务注册失败：$($_.Exception.Message)"
  Say '       守夜人将无法在 DSH 掉线时自动拉起（其余功能不受影响）'
}

# ---------- 4. doctor ----------
Say ''
$doctor = Join-Path $Root 'doctor.ps1'
if (Test-Path -LiteralPath $doctor) {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $doctor
} else {
  Say '（没有 doctor.ps1，跳过体检）'
}

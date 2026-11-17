# exit-task.ps1 — 到点退出的兜底，由计划任务 moyu-exit 触发
#
# 为什么需要它：守夜人进程只活在「电脑开着且 DSH 活着」的时候。
# 关机一晚，03:42 的自动退出就没发生，第二天要等我手动 status 才补。
# 计划任务带 StartWhenAvailable —— 错过的执行在下次开机/登录后补跑。
#
# 这个脚本自己判断该不该退：mode 不是 moyu 就不动；还没到点就不动。
# 真正的退出仍然交给 moyu.ps1 exit（撤锁、停守夜人、生成报告都在那儿）。

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$Root = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($Root)) { $Root = Split-Path -Parent $MyInvocation.MyCommand.Path }
$statePath = Join-Path $Root 'state.json'
$logPath = Join-Path $Root 'logs\exit-task.log'

function Write-Log([string]$msg) {
  $line = '[' + (Get-Date -Format 'yyyy-MM-ddTHH:mm:ssK') + '] ' + $msg
  try {
    $dir = Split-Path -Parent $logPath
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
  } catch {}
}

if (-not (Test-Path -LiteralPath $statePath)) { Write-Log 'no state.json; nothing to do'; exit 0 }

$state = $null
try { $state = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json } catch {}
if ($null -eq $state) { Write-Log 'state.json unreadable; nothing to do'; exit 0 }
if ($state.mode -ne 'moyu') { Write-Log ('mode is ' + $state.mode + '; nothing to do'); exit 0 }

$ends = $null
try { $ends = [DateTimeOffset]::Parse([string]$state.sessionEnds) } catch {}
if ($null -eq $ends) { Write-Log 'sessionEnds unreadable; exiting anyway' }
elseif ([DateTimeOffset]::Now -lt $ends.AddMinutes(-2)) {
  # 规则上不该发生（任务就是按 sessionEnds 排的），但时钟/时区变化时防一手
  Write-Log ('woke too early (' + [DateTimeOffset]::Now.ToString('HH:mm') + ' < ' + $ends.ToString('HH:mm') + '); skip')
  exit 0
}

Write-Log 'window ended; running moyu.ps1 exit'
try {
  $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'moyu.ps1') exit 2>&1
  Write-Log ('exit result: ' + (($out | Out-String).Trim()))
} catch {
  Write-Log ('exit failed: ' + $_.Exception.Message)
  exit 1
}
exit 0

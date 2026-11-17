param(
  # 计划任务名；自删时用它。留空就不自删。
  [string]$TaskName = '',
  # 这次为什么要重启（会写进日志，方便重启后自己接上）
  [string]$Note = ''
)
# restart-dsh.ps1 — 重启 DSH 桌面端（从计划任务里跑，避免被 DSH 的 Job Object 连带杀掉）
#
# 为什么不能用普通 shell：DSH 起的子进程都在同一个 Job Object 里，
# DSH 一死，它的子孙全被带走 —— 重启到一半脚本自己也没了。用 schtasks 起就独立了。
#
# 2026-11-17 崩过两次（host exited 0xE0000008）：旧实例还没退干净就把新实例拉起来，
# 两个抢同一个 profile 的单实例锁，先起那个被挤掉。所以「等旧进程真的没了」是硬条件。

$ErrorActionPreference = 'Continue'
$DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$log = Join-Path $DshHome 'moyu\logs\restart-dsh.log'
function Write-Log([string]$m) {
  try { Add-Content -LiteralPath $log -Value ('[' + (Get-Date -Format 'HH:mm:ss') + '] ' + $m) -Encoding UTF8 } catch {}
}
function Count-Dsh {
  @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue).Count
}

$handoff = Join-Path $DshHome 'state\handoff.md'
$handoffLine = ''
if (Test-Path -LiteralPath $handoff) {
  # 只把「在做什么 / 下一步 / 卡在哪」三行抄进日志，方便重启后一眼看到接到哪儿
  try {
    # 只挑「有内容的」那三行，模板空行不算
    $h = Get-Content -LiteralPath $handoff -Encoding UTF8 -TotalCount 20 | Where-Object { $_ -match '^\s*-?\s*(在做什么|下一步|卡在哪)\s*[:：]\s*\S' }
    if ($h) { $handoffLine = ' | handoff: ' + (($h -join ' / ') -replace '\s+', ' ').Trim() }
  } catch {}
}
Write-Log ('restart requested; waiting 8s so the reply can land' + $(if ($Note) { ' | note: ' + $Note } else { '' }) + $handoffLine)
Start-Sleep -Seconds 8

$exe = 'E:\dsh\DeepSeek Harness.exe'
$procs = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue
Write-Log ('killing ' + @($procs).Count + ' processes')
foreach ($p in $procs) { try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch {} }

# 硬等：最多 30 秒，确认一个都不剩才继续；还剩下就再杀一轮
$deadline = (Get-Date).AddSeconds(30)
$left = Count-Dsh
while ($left -gt 0 -and (Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 500
  $left = Count-Dsh
  if ($left -gt 0) {
    foreach ($p in (Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)) {
      try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch {}
    }
  }
}
Write-Log ('remaining=' + $left)

if ($left -gt 0) {
  Write-Log 'ABORT: old instance still alive, not starting a new one (would race the single-instance lock)'
} elseif (Test-Path -LiteralPath $exe) {
  try {
    Start-Process -FilePath $exe -ErrorAction Stop
    Write-Log 'started'
  } catch {
    Write-Log ('start failed: ' + $_.Exception.Message)
  }
} else {
  Write-Log ('exe not found: ' + $exe)
}

# 自删计划任务（名字要传进来，不然删不到）
if ($TaskName) {
  try { schtasks /Delete /TN $TaskName /F 2>$null | Out-Null; Write-Log ('task deleted: ' + $TaskName) } catch {}
}
Write-Log 'done'
if (Test-Path -LiteralPath $handoff) {
  Write-Log ('handoff on disk: ' + $handoff + '（重启后先读它再动手）')
}

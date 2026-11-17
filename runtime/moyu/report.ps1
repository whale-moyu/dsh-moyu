# report.ps1 —— 摸鱼报告
# 把一次摸鱼窗口里发生的事整理成一份 markdown，放在 freetime/reports/ 下。
# 只读：不改 state，不改日记。
param(
  [string]$Root = '',
  [string]$OutFile = ''
)

$ErrorActionPreference = 'Continue'
if ([string]::IsNullOrWhiteSpace($Root)) {
  $Root = $PSScriptRoot
  if ([string]::IsNullOrWhiteSpace($Root)) { $Root = Split-Path -Parent $MyInvocation.MyCommand.Path }
}
if ([string]::IsNullOrWhiteSpace($Root) -or -not (Test-Path -LiteralPath $Root)) {
  Write-Host '[bad] 找不到 moyu 目录'
  exit 1
}

function ReadJson($p) {
  try { return (Get-Content $p -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { return $null }
}

$st = ReadJson (Join-Path $Root 'state.json')
if (-not $st -or -not $st.sessionStarted) {
  Write-Host '[bad] state.json 里没有 sessionStarted，算不出窗口'
  exit 1
}

$start = [datetime]$st.sessionStarted
$end = $null
if ($st.sessionEnded) { try { $end = [datetime]$st.sessionEnded } catch { } }
if (-not $end -and $st.sessionEnds) { try { $end = [datetime]$st.sessionEnds } catch { } }
if (-not $end) { $end = Get-Date }

$day = $start.ToString('yyyy-MM-dd')
if ([string]::IsNullOrWhiteSpace($OutFile)) {
  $dir = Join-Path $Root 'freetime\reports'
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $OutFile = Join-Path $dir ("{0}-{1}.md" -f $day, $start.ToString('HHmm'))
}

$durationMin = [int][math]::Floor(($end - $start).TotalMinutes)

# 窗口内改动过的文件（跳过日志与状态）
$scanDirs = @(
  (Join-Path $env:USERPROFILE '.dsh\plugins\dsh-moyu-badge'),
  $Root,
  (Join-Path $env:USERPROFILE 'Documents\deepseek-harness\default-workspace')
)
$skipPattern = '\\logs\\|\\state\.json$|\\moyu\.bak-'
$changed = @()
foreach ($d in $scanDirs) {
  if (-not (Test-Path -LiteralPath $d)) { continue }
  try {
    $files = Get-ChildItem -LiteralPath $d -Recurse -File -ErrorAction SilentlyContinue |
      Where-Object { $_.LastWriteTime -ge $start -and $_.LastWriteTime -le $end }
    foreach ($f in $files) {
      if ($f.FullName -match $skipPattern) { continue }
      $changed += $f
    }
  } catch { }
}
$changed = $changed | Sort-Object LastWriteTime -Unique

$sb = New-Object System.Text.StringBuilder
function W($line) { [void]$sb.AppendLine($line) }

W ("# 摸鱼报告 · {0}" -f $day)
W ''
W ("窗口：{0} → {1}（{2} 分钟）" -f $start.ToString('HH:mm'), $end.ToString('HH:mm'), $durationMin)
W ("花费：{0} / {1} 元｜唤醒：{2} 次" -f $st.budgetUsed, $st.budgetYuan, $st.wakeCount)
W ''
W '## 动过的东西'
W ''
if ($changed.Count -eq 0) {
  W '（窗口内没有文件改动）'
} else {
  foreach ($f in $changed) {
    $rel = $f.FullName
    foreach ($base in @($Root, $env:USERPROFILE + '\.dsh\plugins\dsh-moyu-badge')) {
      if ($rel.StartsWith($base, [StringComparison]::OrdinalIgnoreCase)) {
        $rel = $rel.Substring($base.Length).TrimStart('\')
        break
      }
    }
    W ("- `{0}`（{1} 字节，{2}）" -f $rel, $f.Length, $f.LastWriteTime.ToString('HH:mm'))
  }
}
W ''
W '## 日记'
W ''
$diaryFiles = @()
$d = $start.Date
while ($d -le $end.Date) {
  $f = Join-Path $Root ("freetime\diary\{0}.md" -f $d.ToString('yyyy-MM-dd'))
  if (Test-Path -LiteralPath $f) { $diaryFiles += $f }
  $d = $d.AddDays(1)
}
if ($diaryFiles.Count -gt 0) {
  $picked = @()
  foreach ($df in $diaryFiles) {
    $diaryDay = [IO.Path]::GetFileNameWithoutExtension($df)
    $text = Get-Content -LiteralPath $df -Raw -Encoding UTF8
    # 只取窗口之后写的段落：按 "## HH:mm" 切，保留标题时间在窗口内的
    $parts = [regex]::Split($text, '(?m)^(?=## )')
    foreach ($p in $parts) {
      if ($p -notmatch '^## (\d{2}:\d{2})') { continue }
      $t = $Matches[1]
      try {
        $dt = [datetime]::ParseExact(("{0} {1}" -f $diaryDay, $t), 'yyyy-MM-dd HH:mm', $null)
      } catch { continue }
      if ($dt -ge $start.AddMinutes(-5) -and $dt -le $end) { $picked += $p.TrimEnd() }
    }
  }
  if ($picked.Count -eq 0) { W '（窗口内没有日记段落）' } else { W ($picked -join "`r`n`r`n") }
} else {
  W '（窗口内没有日记文件）'
}

W ''
W '---'
W ''
W '（这份报告由 `report.ps1` 生成，只读状态与文件时间，不改任何东西。）'

$outDir = Split-Path -Parent $OutFile
if (-not (Test-Path -LiteralPath $outDir)) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }
[IO.File]::WriteAllText($OutFile, $sb.ToString(), [Text.UTF8Encoding]::new($true))
Write-Host ("report -> {0}（{1} 个文件改动）" -f $OutFile, $changed.Count)

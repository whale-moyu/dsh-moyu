param(
  [switch]$List,
  [string]$Archive = '',
  [int]$KeepDays = 7,
  [string]$Root = ''
)

# 日记归档工具
#
# 规则：保留最近 7 天原文。更老的由 DSH 读一遍、写压缩版，然后把原文移进 archive/。
# 这个脚本只做两件事：列出「该压了」的文件、把某个原文搬进 archive/。
# 压缩本身是 DSH 在对话里做的，脚本不碰正文。
#
#   compact-diary.cmd -List                 列出超过 7 天、还在 diary/ 里的日记
#   compact-diary.cmd -Archive 2026-10-20   把那一天的原稿移进 archive/

if ([string]::IsNullOrWhiteSpace($Root)) {
  $Root = $PSScriptRoot
  if ([string]::IsNullOrWhiteSpace($Root)) {
    $Root = Split-Path -Parent $MyInvocation.MyCommand.Path
  }
}

$diaryDir = Join-Path $Root 'freetime\diary'
$archiveDir = Join-Path $Root 'freetime\archive'
$cutoff = (Get-Date).Date.AddDays(-$KeepDays)

function Get-OldDiaries {
  if (-not (Test-Path -LiteralPath $diaryDir)) { return @() }
  Get-ChildItem -LiteralPath $diaryDir -File -Filter '*.md' | Where-Object {
    $d = [datetime]::MinValue
    $ok = [datetime]::TryParseExact(
      [IO.Path]::GetFileNameWithoutExtension($_.Name),
      'yyyy-MM-dd',
      [Globalization.CultureInfo]::InvariantCulture,
      [Globalization.DateTimeStyles]::None,
      [ref]$d
    )
    $ok -and $d -lt $cutoff
  }
}

if ($Archive -ne '') {
  $name = $Archive.Trim()
  if ($name -notmatch '^\d{4}-\d{2}-\d{2}$') {
    Write-Host 'bad-date: expected yyyy-MM-dd'
    exit 1
  }
  $src = Join-Path $diaryDir "$name.md"
  if (-not (Test-Path -LiteralPath $src)) {
    Write-Host "not-found: $src"
    exit 1
  }
  if (-not (Test-Path -LiteralPath $archiveDir)) {
    New-Item -ItemType Directory -Path $archiveDir -Force | Out-Null
  }
  $dst = Join-Path $archiveDir "$name.md"
  if (Test-Path -LiteralPath $dst) {
    Write-Host "conflict: $dst already exists"
    exit 1
  }
  # diary-guard 会给旧日记加 deny 写+删，搬家前先解除，搬完不恢复（归档本该由规则生成）
  $dg = Join-Path $Root 'diary-guard.ps1'
  if (Test-Path -LiteralPath $dg) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $dg -Unlock $name | Out-Null
  }
  Move-Item -LiteralPath $src -Destination $dst
  Write-Host "archived: $name -> freetime\archive\$name.md"
  exit 0
}

$old = Get-OldDiaries
if ($null -eq $old) { $old = @() }
if ($old.Count -eq 0) {
  Write-Host "none: no diary older than $KeepDays days"
  exit 0
}

Write-Host "pending: $($old.Count) file(s) older than $KeepDays days"
foreach ($f in ($old | Sort-Object Name)) {
  $bytes = (Get-Item -LiteralPath $f.FullName).Length
  Write-Host ("  {0}  {1} bytes  {2}" -f [IO.Path]::GetFileNameWithoutExtension($f.Name), $bytes, $f.LastWriteTime.ToString('yyyy-MM-dd HH:mm'))
}

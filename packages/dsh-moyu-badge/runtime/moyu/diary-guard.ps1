param(
  [switch]$Apply,
  [switch]$Status,
  [string]$Unlock = '',
  [string]$Root = ''
)

# Diary guard: freeze past entries, block deletion of past entries.
#
#   diary-guard.cmd -Apply            freeze every diary file older than today
#   diary-guard.cmd -Status           show per-file state
#   diary-guard.cmd -Unlock 2026-10-20   remove the deny ACEs (used by archive)
#
# What it does, per file in freetime/diary:
#   * date < today  -> deny WRITE and DELETE for the current user
#     (content can no longer be rewritten, file can no longer be deleted)
#   * today         -> untouched (still writable, so the day can be written)
#
# This is a tamper seal, not a vault: the account is Administrator, so
# takeown + icacls /remove:d can lift it.  Lifting it is a deliberate act
# and leaves owner changes behind.

if ([string]::IsNullOrWhiteSpace($Root)) {
  $Root = Split-Path -Parent $MyInvocation.MyCommand.Path
}

$diaryDir = Join-Path $Root 'freetime\diary'
$logFile  = Join-Path $Root 'logs\diary-guard.log'
$user     = [Security.Principal.WindowsIdentity]::GetCurrent().Name

function Write-Log {
  param([string]$msg)
  $line = ('{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg)
  try {
    $dir = Split-Path -Parent $logFile
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    [IO.File]::AppendAllText($logFile, $line + "`r`n", [Text.UTF8Encoding]::new($false))
  } catch { }
}

function Get-DiaryDate {
  param([string]$name)
  $d = [datetime]::MinValue
  $ok = [datetime]::TryParseExact(
    [IO.Path]::GetFileNameWithoutExtension($name),
    'yyyy-MM-dd',
    [Globalization.CultureInfo]::InvariantCulture,
    [Globalization.DateTimeStyles]::None,
    [ref]$d
  )
  if ($ok) { return $d }
  return $null
}

function Get-DiaryFiles {
  if (-not (Test-Path -LiteralPath $diaryDir)) { return @() }
  Get-ChildItem -LiteralPath $diaryDir -File -Filter '*.md' | Where-Object { $null -ne (Get-DiaryDate $_.Name) }
}

function Invoke-Icacls {
  param([string[]]$argv)
  $out = & icacls @argv 2>&1
  return [pscustomobject]@{ Code = $LASTEXITCODE; Text = ($out | Out-String).Trim() }
}

if ($Unlock -ne '') {
  $name = $Unlock.Trim()
  $f = Join-Path $diaryDir ($name + '.md')
  if (-not (Test-Path -LiteralPath $f)) { Write-Output "not-found: $f"; exit 1 }
  $r = Invoke-Icacls @($f, '/remove:d', $user)
  $null = Invoke-Icacls @($f, '/remove:d', 'moyu')
  if ($r.Code -ne 0) { Write-Output ('unlock failed: ' + $r.Text); exit 1 }
  Write-Log ("unlock $name")
  Write-Output "unlocked: $name"
  exit 0
}

if ($Status) {
  $rows = @()
  foreach ($f in (Get-DiaryFiles | Sort-Object Name)) {
    $acl = (Invoke-Icacls @($f.FullName)).Text
    $denied = ($acl -match 'DENY')
    $rows += [pscustomobject]@{
      File   = [IO.Path]::GetFileNameWithoutExtension($f.Name)
      Deny   = $denied
      Bytes  = $f.Length
      Write  = $f.LastWriteTime.ToString('yyyy-MM-dd HH:mm')
    }
  }
  if ($rows.Count -eq 0) { Write-Output 'none: no dated diary files' } else { $rows | Format-Table -AutoSize | Out-String }
  exit 0
}

if (-not $Apply) {
  Write-Output 'usage: diary-guard.ps1 -Apply | -Status | -Unlock yyyy-MM-dd'
  exit 1
}

$today = (Get-Date).Date
$froze = 0
$skipped = 0
foreach ($f in (Get-DiaryFiles | Sort-Object Name)) {
  $d = Get-DiaryDate $f.Name
  if ($null -eq $d -or $d -ge $today) {
    $skipped++
    continue
  }
  # 2026-11-16 修：原来用 (W,DE)，而 icacls 的 W = FILE_GENERIC_WRITE，含 SYNCHRONIZE，
  # 结果封印之后连读都读不了（`Get-Content`/`cmd type` 全 Access denied），
  # 摸鱼日记等于被封成别人看不见的黑盒。改成逐项列，不含 Synchronize。
  $denyRights = '(WD,AD,WEA,WA,DE)'
  $r = Invoke-Icacls @($f.FullName, '/deny', ($user + ':' + $denyRights))
  # 换了受限身份之后，moyu 也能写 freetime：旧日记对它同样要封，否则封印只挡一半。
  $null = Invoke-Icacls @($f.FullName, '/deny', ('moyu:' + $denyRights))
  if ($r.Code -eq 0) {
    $froze++
  } else {
    Write-Log ('freeze failed: ' + $f.Name + ' :: ' + $r.Text)
  }
}
Write-Log ("apply: frozen=$froze today_skipped=$skipped")
Write-Output ("frozen: $froze file(s); today kept writable: $skipped file(s)")

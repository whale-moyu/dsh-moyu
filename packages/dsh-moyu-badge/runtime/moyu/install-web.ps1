# install-web.ps1 —— 装「AI 专属浏览器」的账号与封禁（第四条：禁 file:// 与内网）
# 【称呼对照】本机有两个受限账号，名字是英文，意思在这里：
#   moyu  = 摸鱼账号：能写 playground 与 freetime，不出网；摸鱼时跑小程序用它。
#   akweb = 浏览器账号：能上网，碰不到用户目录；AI 浏览器以它的身份运行。
# 装什么：
#   1. 本地标准账号 akweb（非管理员，随机密码 → secrets\web-account.json，只管理员可读）
#   2. 它的浏览器 profile 目录 C:\Users\akweb\AkWebProfile（登录态留在这里）
#   3. 防火墙：akweb 出站一律不许连本机与局域网（127/8、10/8、172.16/12、192.168/16、169.254/16、LocalSubnet）
#   4. akweb 的 Edge 策略：URLBlocklist 禁 file:///*
# 跑法：powershell -NoProfile -ExecutionPolicy Bypass -File install-web.ps1
param([string]$Root = '')

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

if ([string]::IsNullOrWhiteSpace($Root)) { $Root = $PSScriptRoot }
$secDir = Join-Path $Root 'secrets'
$secFile = Join-Path $secDir 'web-account.json'
$userName = 'akweb'
$profileDir = "C:\Users\$userName\AkWebProfile"

function Say($s) { Write-Host $s }

# ── 1. 账号 ─────────────────────────────────────────────
$u = Get-LocalUser -Name $userName -ErrorAction SilentlyContinue
if (-not $u) {
  $pw = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 28 | ForEach-Object { [char]$_ })
  $sec = ConvertTo-SecureString $pw -AsPlainText -Force
  New-LocalUser -Name $userName -Password $sec -PasswordNeverExpires `
    -Description 'DSH AI 专属浏览器账号（普通用户）' -UserMayNotChangePassword | Out-Null
  New-Item -ItemType Directory -Force -Path $secDir | Out-Null
  @{ username = $userName; password = $pw; created = (Get-Date).ToString('s') } |
    ConvertTo-Json | Set-Content -LiteralPath $secFile -Encoding utf8
  Say "✓ 账号 $userName 已创建，密码写进 secrets\web-account.json"
} else {
  if (-not (Test-Path -LiteralPath $secFile)) {
    throw "账号 $userName 已存在但没有密码文件。先 Remove-LocalUser $userName 再重跑本脚本。"
  }
  Say "✓ 账号 $userName 已存在"
}
$sid = (Get-LocalUser -Name $userName).SID.Value

icacls $secDir /inheritance:r /grant:r 'BUILTIN\Administrators:(OI)(CI)F' 'NT AUTHORITY\SYSTEM:(OI)(CI)F' | Out-Null
icacls $secFile /inheritance:r /grant:r 'BUILTIN\Administrators:(F)' 'NT AUTHORITY\SYSTEM:(F)' | Out-Null
Say '✓ 密码文件权限：只有 Administrators / SYSTEM'

# 确认不是管理员
$admins = (Get-LocalGroupMember -Group 'Administrators' -ErrorAction SilentlyContinue).Name
if ($admins -match [regex]::Escape($userName)) { throw "$userName 居然在 Administrators 组里，停。" }
Say '✓ 不是管理员'

# ── 2. profile 目录 ────────────────────────────────────
if (-not (Test-Path -LiteralPath $profileDir)) { New-Item -ItemType Directory -Force -Path $profileDir | Out-Null }
icacls $profileDir /grant:r "${userName}:(OI)(CI)F" | Out-Null
Say "✓ profile 目录：$profileDir（登录态留在这里）"

# ── 3. 防火墙：不许连本机与局域网 ───────────────────────
$ruleName = 'Ak Web-NoLocal'
Remove-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
$sddl = "D:(A;;CC;;;$sid)"
New-NetFirewallRule -DisplayName $ruleName -Direction Outbound -Action Block -Profile Any `
  -LocalUser $sddl `
  -RemoteAddress @('127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', 'LocalSubnet') | Out-Null
Say "✓ 防火墙规则 $ruleName：$userName 连不到本机与局域网"

# ── 4. Edge 策略：禁 file:// ───────────────────────────
$hive = 'HKU\akweb_tmp'
$ntuser = "C:\Users\$userName\NTUSER.DAT"
if (Test-Path -LiteralPath $ntuser) {
  $loaded = $false
  try {
    cmd /c "reg unload `"$hive`"" 2>$null | Out-Null
    cmd /c "reg load `"$hive`" `"$ntuser`"" | Out-Null
    if ($LASTEXITCODE -eq 0) {
      $loaded = $true
      $k = "$hive\Software\Policies\Microsoft\Edge\URLBlocklist"
      cmd /c "reg add `"$k`" /v 1 /t REG_SZ /d `"file:///*`" /f" | Out-Null
      Say '✓ Edge 策略：file:///* 已封（只作用于 akweb 这个账号）'
    } else {
      Say '! 加载 akweb 的注册表失败，file:// 暂时没封（其它都好了）'
    }
  } finally {
    if ($loaded) { cmd /c "reg unload `"$hive`"" 2>$null | Out-Null }
  }
} else {
  Say '! 找不到 akweb 的 NTUSER.DAT，file:// 没封'
}

Say ''
Say '接下来跑 run-web.ps1 就能起浏览器。'

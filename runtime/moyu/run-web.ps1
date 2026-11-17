# run-web.ps1 —— 以 akweb 身份起 Edge（AI 专属浏览器）
# 【称呼对照】本机有两个受限账号，名字是英文，意思在这里：
#   moyu  = 摸鱼账号：能写 playground 与 freetime，不出网；摸鱼时跑小程序用它。
#   akweb = 浏览器账号：能上网，碰不到用户目录；AI 浏览器以它的身份运行。
# 用法：
#   .\run-web.ps1                      只起浏览器（空白页）
#   .\run-web.ps1 -Url https://...     起浏览器并打开这个网址
#   .\run-web.ps1 -Stop                关掉这个浏览器
#   .\run-web.ps1 -Probe <url>         起浏览器 → 打开 → 等 6 秒 → 回报能否打开（探针）
param(
  [string]$Url = 'about:blank',
  [switch]$Stop,
  [string]$Probe = '',
  [switch]$Detached
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$Root = $PSScriptRoot
$secFile = Join-Path (Join-Path $Root 'secrets') 'web-account.json'
if (-not (Test-Path -LiteralPath $secFile)) { throw '没有 secrets\web-account.json，先跑 install-web.ps1' }
$acc = Get-Content -LiteralPath $secFile -Raw -Encoding UTF8 | ConvertFrom-Json
$userName = $acc.username
$cred = New-Object System.Management.Automation.PSCredential(
  $userName, (ConvertTo-SecureString $acc.password -AsPlainText -Force))

$exe = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$profileDir = "C:\Users\$userName\AkWebProfile"
$userHome = "C:\Users\$userName"
$debugPort = 9333

function Get-BrowserProcs {
  Get-Process msedge -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq (Get-Process -Id $PID).SessionId }
}

if ($Stop) {
  Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" |
    Where-Object { $_.CommandLine -like "*$profileDir*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  '已关'
  exit 0
}

if ($Probe) { $Url = $Probe }

# 代理是浏览器唯一的出网通道：起浏览器之前先把它拉起来（摸鱼期间由守夜人维持，
# 这里兜的是「没在摸鱼、但我要用浏览器」的情况）。
$watch = Join-Path $Root 'web-proxy-watch.ps1'
if (Test-Path -LiteralPath $watch) {
  try { $null = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $watch -Quiet 2>&1 } catch {}
}

# 下载投递箱：目录不存在时 CDP 的 setDownloadBehavior 会失败，下载直接没影，
# 所以起浏览器前先把目录建好并给 akweb 写权限。
$inbox = "C:\Users\$userName\Downloads\ak-inbox"
if (-not (Test-Path -LiteralPath $inbox)) {
  New-Item -ItemType Directory -Force -Path $inbox | Out-Null
  & icacls $inbox /grant "${userName}:(OI)(CI)M" 2>&1 | Out-Null
}
$argsList = @(
  "--user-data-dir=$profileDir",
  "--remote-debugging-port=$debugPort",
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-sync',
  '--disable-extensions',
  '--disable-component-update',
  '--proxy-server=http://127.0.0.1:9334',
  '--proxy-bypass-list=<-loopback>',
  $Url
)

if ($Incognito) { $argsList = $argsList[0..($argsList.Count-2)] + @('--incognito', $Url) }

# Start-Process -Credential 起的 GUI 在本会话（session 1）里正常显示，浏览器也能活到 -Stop。
# 之前「脚本收尾超时」不是它没起来，而是它继承了调用方的 stdout 管道：调用方一直等 EOF。
# 所以调用侧改成 stdio: 'ignore'（不接管道），这里保持原样。
# 关键：浏览器必须脱出 DSH 的作业对象，否则这次调用一结束、作业一关，浏览器就被连带杀掉
# （实测：脚本在调用期间浏览器活得好好的，脚本一退就没了）。
# 所以先在「分离模式」里重生自己（hidden-run.exe 带 CREATE_BREAKAWAY_FROM_JOB），
# 由那个脱离作业的进程去起 Edge。
if (-not $Detached) {
  $runner = 'C:\NapCat\hidden-run.exe'
  if (Test-Path -LiteralPath $runner) {
    $inner = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -Detached -Url "' + $Url + '"'
    if ($Probe) { $inner = $inner + ' -Probe "' + $Probe + '"' }
    & $runner $inner | Out-Null
    "已以 $userName 身份启动（分离进程）：$Url"
    exit 0
  }
}
# 2026-11-17 撤掉：FileUrlNavigationEnabled 在这版 Edge 上被标成「错误」，策略不生效。
# file:// 的防线改成两条真的：web-cdp 导航层直接拒 + akweb 的 ACL 让它读不到内容。
Start-Process -FilePath $exe -Credential $cred -ArgumentList $argsList -WorkingDirectory $userHome | Out-Null
"已以 $userName 身份启动：$Url"

if ($Probe) {
  Start-Sleep -Seconds 8
  try {
    $t = Invoke-WebRequest -Uri "http://127.0.0.1:$debugPort/json/version" -UseBasicParsing -TimeoutSec 5
    "调试端口 OK：$($t.StatusCode)"
  } catch {
    "调试端口失败：$($_.Exception.Message)"
  }
  $tabs = (Invoke-RestMethod -Uri "http://127.0.0.1:$debugPort/json/list" -TimeoutSec 5 -ErrorAction SilentlyContinue)
  if ($tabs) { $tabs | ForEach-Object { "tab: $($_.title) <- $($_.url)" } }
}

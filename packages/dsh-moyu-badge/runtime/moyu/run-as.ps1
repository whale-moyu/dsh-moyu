# L3：把一次执行放到受限账号 moyu 下跑。
# 【称呼对照】本机有两个受限账号，名字是英文，意思在这里：
#   moyu  = 摸鱼账号：能写 playground 与 freetime，不出网；摸鱼时跑小程序用它。
#   akweb = 浏览器账号：能上网，碰不到用户目录；AI 浏览器以它的身份运行。
# 用法（由 dsh-moyu-badge 的 moyu_run 调用）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File run-as.ps1 `
#     -Exe <可执行文件绝对路径> -ArgsJson <参数 JSON 文件> -Cwd <工作目录> `
#     -TimeoutSec 60 -OutBase <输出前缀（不含扩展名）> [-Detach]
#   -Detach：起完就返回、不等它结束（游戏这类长驻前台程序用），退出码写进 <OutBase>.pid。
# 非 Detach：输出写到 <OutBase>.out / <OutBase>.err；退出码透传；超时退出码 124。
# 批处理里固定 set ELECTRON_RUN_AS_NODE=1：这样「DeepSeek Harness.exe」也能当 node 用（省掉 bin\node.exe 副本）。
param(
  [Parameter(Mandatory=$true)][string]$Exe,
  [string]$ArgsJson = '',
  [Parameter(Mandatory=$true)][string]$Cwd,
  [int]$TimeoutSec = 60,
  [Parameter(Mandatory=$true)][string]$OutBase,
  [switch]$Detach
)

$ErrorActionPreference = 'Stop'

$secPath = Join-Path $PSScriptRoot 'secrets\moyu-account.json'
if (-not (Test-Path -LiteralPath $secPath)) { Write-Error 'moyu 账号密码文件不在，L3 起不来'; exit 3 }
$pw = (Get-Content -LiteralPath $secPath -Raw | ConvertFrom-Json).password
$cred = New-Object System.Management.Automation.PSCredential('moyu', (ConvertTo-SecureString $pw -AsPlainText -Force))

$argv = @()
if ($ArgsJson -and (Test-Path -LiteralPath $ArgsJson)) {
  $raw = Get-Content -LiteralPath $ArgsJson -Raw -Encoding utf8
  if ($raw.Trim()) { $argv = $raw | ConvertFrom-Json; if ($null -eq $argv) { $argv = @() } elseif ($argv -isnot [array]) { $argv = @($argv) } }
}
function Q([string]$s) {
  if ($null -eq $s) { return '""' }
  return '"' + ($s -replace '"','""') + '"'
}

$exeLine = (Q $Exe)
foreach ($a in $argv) { $exeLine = $exeLine + ' ' + (Q ([string]$a)) }

if ($exeLine -match "[`r`n]") {
  Write-Error '参数里带换行，批处理传不过去 —— 请把代码写成一个脚本文件放进游乐场再运行'
  exit 4
}

$outFile = $OutBase + '.out'
$errFile = $OutBase + '.err'
$batch = $OutBase + '.cmd'

if ($Detach) {
  # 长驻程序（游戏）：用 start 起，批处理立刻退出，于是 run-as 也能立刻返回；
  # 程序自己留在那儿跑，等 moyu_desktop 去点，或者主人自己接管。
  $body = "@echo off`r`nset ELECTRON_RUN_AS_NODE=1`r`ncd /d $(Q $Cwd)`r`nstart `"moyu-detach`" $exeLine`r`nexit /b 0`r`n"
} else {
  $body = "@echo off`r`nset ELECTRON_RUN_AS_NODE=1`r`ncd /d $(Q $Cwd)`r`n$exeLine > $(Q $outFile) 2> $(Q $errFile)`r`nexit /b %ERRORLEVEL%`r`n"
}
[System.IO.File]::WriteAllText($batch, $body, [System.Text.Encoding]::GetEncoding(936))

$p = Start-Process -FilePath $env:ComSpec -ArgumentList @('/c', (Q $batch)) -Credential $cred `
  -WorkingDirectory (Split-Path -Parent $OutBase) -PassThru -WindowStyle Hidden

if ($Detach) {
  # 等 start 落地就够了；不去 WaitForExit，也不杀任何人。
  [void]$p.WaitForExit(8000)
  exit 0
}

$ms = [Math]::Max(1000, $TimeoutSec * 1000)
if (-not $p.WaitForExit($ms)) {
  try { & taskkill.exe /F /T /PID $p.Id 2>$null | Out-Null } catch {}
  exit 124
}
exit $p.ExitCode

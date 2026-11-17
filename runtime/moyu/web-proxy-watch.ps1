# web-proxy-watch.ps1 —— 闸门看门狗：代理没在跑就拉起来，挂了记一笔
# 【称呼对照】本机有两个受限账号，名字是英文，意思在这里：
#   moyu  = 摸鱼账号：能写 playground 与 freetime，不出网；摸鱼时跑小程序用它。
#   akweb = 浏览器账号：能上网，碰不到用户目录；AI 浏览器以它的身份运行。
# 为什么需要它：浏览器所有请求都要过 127.0.0.1:9334 这道闸门；代理一挂，浏览器就什么都打不开。
# 由计划任务 Ak WebProxy 每分钟跑一次（开机也跑一次）。
param([switch]$Quiet)
$ErrorActionPreference = 'Continue'
$moyu = Join-Path $env:USERPROFILE '.dsh\moyu'
$log = Join-Path $moyu 'freetime\web-proxy-watch.log'
$node = Join-Path $moyu 'bin\node.exe'
$script = Join-Path $moyu 'web-proxy.mjs'

function Note($m) {
  $line = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss') + ' ' + $m
  try { Add-Content -LiteralPath $log -Value $line -Encoding UTF8 } catch {}
  if (-not $Quiet) { Write-Output $m }
}

function Healthy {
  try {
    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:9334/__health' -TimeoutSec 3 -UseBasicParsing
    return $r.StatusCode -eq 200
  } catch { return $false }
}

if (Healthy) { if (-not $Quiet) { Note '代理在' }; exit 0 }

# 1) 端口被占但不是我们的进程 -> 记一笔，别乱杀
$busy = Get-NetTCPConnection -LocalPort 9334 -State Listen -ErrorAction SilentlyContinue
if ($busy) {
  $procId = ($busy | Select-Object -First 1).OwningProcess
  $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
  Note ("端口 9334 被占用但不是健康代理（PID $procId " + ($p.ProcessName) + '），先杀掉重起')
  try { Stop-Process -Id $procId -Force -ErrorAction Stop } catch { Note '杀不掉，放弃这轮'; exit 1 }
}

# 2) 起代理（隐藏窗口，脱离当前作业对象）
if (-not (Test-Path -LiteralPath $node)) { Note "找不到 node：$node"; exit 1 }
$runner = 'C:\NapCat\hidden-run.exe'
# hidden-run.exe 只认「一个整串」：exe 和脚本用引号包成一条命令行，拆成数组它不执行
$cmdLine = '"' + $node + '" "' + $script + '"'
# 用 cmd 包装器起：它内部 start /b 立刻返回，常驻的 node 不会占着调用方的 stdout 管道
# （不这样做，run-web.ps1 起的代理会让父进程一直等 EOF，表现成「脚本超时」）。
$starter = Join-Path $moyu 'web-proxy-start.cmd'
if ((Test-Path -LiteralPath $runner) -and (Test-Path -LiteralPath $starter)) {
  $line = 'cmd.exe /c "' + $starter + '"'
  Push-Location $moyu
  try { & $runner $line | Out-Null } finally { Pop-Location }
} elseif (Test-Path -LiteralPath $runner) {
  Push-Location $moyu
  try { & $runner $cmdLine | Out-Null } finally { Pop-Location }
} else {
  Start-Process -FilePath $node -ArgumentList @($script) -WorkingDirectory $moyu -WindowStyle Hidden | Out-Null
}

# 起来要一两秒，最多等 12 秒再判死，别把刚起的代理当失败
$ok = $false
for ($i = 0; $i -lt 24; $i++) {
  Start-Sleep -Milliseconds 500
  if (Healthy) { $ok = $true; break }
}
if ($ok) { Note '代理原本不在，已拉起' } else { Note '拉起来了但 12 秒都不通，需要人看一下' }

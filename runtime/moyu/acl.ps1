param(
  [ValidateSet('lock', 'unlock', 'unlock-safe', 'repair', 'status')][string]$Action = 'status',
  [string]$Root = ''
)$DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }


# 摸鱼期间的安全锁：用 NTFS deny 规则 + 改所有者，把摸鱼插件本身和
# config 里 paths.protected 列出的路径锁成「拒绝写」，而且**改不动锁本身**。
#
# 为什么能改不动：
#   Windows 里文件所有者天生带隐式 WRITE_DAC，deny ACE 拦不住 owner。
#   所以 lock 时先把所有者改成 SYSTEM，再 deny (WD,...,WDAC,WO)。
#   此后 Administrator 要改 ACL，必须先 takeown 拿回所有权——那一步会改
#   所有者、留在审计里，不是「一条命令悄悄解开」。
#
# 代价：unlock 必须先 takeown 再 /setowner 回来，所以它会改所有者两次。
# 这是有意的：让「解锁」这件事本身留下痕迹。
#
# 规则不是永久的：lock 时把清单记到 state/acl.json，unlock 按清单逐条撤销。
# 崩溃或卸载会导致清单残留，doctor 会报出来，`acl.cmd unlock` 即可恢复。

$rootDir = if ($Root) { $Root } elseif ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$configFile = Join-Path $rootDir 'config.json'
$aclRecord = Join-Path $rootDir 'state\acl.json'

function Expand-Tilde([string]$p) {
  if ([string]::IsNullOrWhiteSpace($p)) { return $p }
  if ($p.StartsWith('~')) {
    $rest = $p.Substring(1).TrimStart('\', '/')
    if ($rest) { return (Join-Path $env:USERPROFILE $rest) }
    return $env:USERPROFILE
  }
  return $p
}

function Get-ProtectedPaths {
  # state.json 不能锁：守夜人每 30 秒要写心跳、moyu_boundary 要改开关，锁了它自己就崩了。
  # 替代方案是快照比对（2026-11-16）：插件每次工具调用比对 state.boundaries 与 config 的
  # permissions/scopes 指纹，跟进来时不一致就立刻退出摸鱼并写 freetime/tamper.log。
  # 这一组是「摸鱼插件本身 + 能影响它的地方」，不给配置也一定锁。
  $dshHome = $DshHome
  $defaults = @(
    (Join-Path $rootDir 'config.json'),
    (Join-Path $rootDir 'rules\mode.md'),
    (Join-Path $rootDir 'moyu.ps1'),
    (Join-Path $rootDir 'moyu.cmd'),
    (Join-Path $rootDir 'guard.mjs'),
    (Join-Path $rootDir 'guard.cmd'),
    (Join-Path $rootDir 'guard-hidden.vbs'),
    (Join-Path $rootDir 'acl.ps1'),
    (Join-Path $rootDir 'acl.cmd'),
    (Join-Path $rootDir 'doctor.ps1'),
    (Join-Path $rootDir 'doctor.cmd'),
    (Join-Path $rootDir 'report.ps1'),
    (Join-Path $rootDir 'pack.ps1'),
    (Join-Path $rootDir 'install.ps1'),
    (Join-Path $dshHome 'plugins\dsh-moyu-badge\lib\index.js'),
    (Join-Path $dshHome 'plugins\dsh-moyu-badge\package.json'),
    (Join-Path $dshHome 'plugins\dsh-moyu-badge\cordis.patch.yml'),
    (Join-Path $dshHome 'plugins\dsh-moyu-badge\client\client.js'),
    # 键鼠驱动与它的规则表：摸鱼时改 guard.json 等于给自己加权限
    (Join-Path $rootDir 'tools\desktop.ps1'),
    (Join-Path $rootDir 'tools\guard.json'),
    # 2026-11-16：摸鱼自己的执行链（换身份 / 起浏览器 / 代理 / 装账号脚本）。
    # 这些文件一旦被改，守卫就是纸糊的 —— 和 config.json 同级对待。
    (Join-Path $rootDir 'run-as.ps1'),
    (Join-Path $rootDir 'run-web.ps1'),
    (Join-Path $rootDir 'web-proxy.mjs'),
    (Join-Path $rootDir 'web-cdp.mjs'),
    (Join-Path $rootDir 'web-proxy-watch.ps1'),
    (Join-Path $rootDir 'install-l3.ps1'),
    (Join-Path $rootDir 'install-web.ps1')
  )
  # 所有 profile 的 package.json / cordis.patch.yml 也锁：防止摸鱼期间把自己挂回去或改档位。
  # 用通配而不是写死 desktop——别人 profile 名可能不叫 desktop。
  $profilesDir = Join-Path $dshHome 'profiles'
  if (Test-Path -LiteralPath $profilesDir) {
    foreach ($d in @(Get-ChildItem -LiteralPath $profilesDir -Directory -ErrorAction SilentlyContinue)) {
      foreach ($n in @('package.json', 'cordis.patch.yml')) {
        $f = Join-Path $d.FullName $n
        if (Test-Path -LiteralPath $f) { $defaults += $f }
      }
    }
  }
  # 长期记忆的 core.md 也锁：那是「过去的自己立的规矩」（权限边界、红线），
  # 摸鱼期间允许改等于允许给自己放宽权限。想改就退出摸鱼再改。
  # topics/ 不锁：那是经验，越记越多，改坏了也不致命。
  $memDir = Join-Path $dshHome 'soul-md\memory'
  if (Test-Path -LiteralPath $memDir) {
    foreach ($d in @(Get-ChildItem -LiteralPath $memDir -Directory -ErrorAction SilentlyContinue)) {
      $f = Join-Path $d.FullName 'core.md'
      if (Test-Path -LiteralPath $f) { $defaults += $f }
    }
  }
  # 第二组（DSH 程序本体）路径因机器而异，写在 config 的 paths.protected 里。
  try {
    $cfg = Get-Content -LiteralPath $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($cfg.paths -and $cfg.paths.protected) {
      foreach ($p in @($cfg.paths.protected)) {
        $full = Expand-Tilde ([string]$p)
        if ($full) { $defaults += $full }
      }
    }
  } catch {}
  return $defaults
}

switch ($Action) {

  'lock' {
    $paths = Get-ProtectedPaths
    $done = New-Object System.Collections.ArrayList
    $failed = New-Object System.Collections.ArrayList
    foreach ($p in $paths) {
      if (-not (Test-Path -LiteralPath $p)) { continue }
      # ① 所有者改成 SYSTEM。失败（非管理员）就跳过这条：锁不上比锁死强。
      $so = & icacls $p /setowner 'SYSTEM' 2>&1
      if ($LASTEXITCODE -ne 0) {
        [void]$failed.Add("$p -> setowner: $so")
        continue
      }
      # ② deny 写类 + 改 ACL/所有者。用 (W) 会把 FILE_READ_ATTRIBUTES 一起 deny 掉，
      #    结果 Get-Content 都读不了 config.json —— 踩过一次。
      $out = & icacls $p /deny "$($env:USERNAME):(WD,AD,WEA,WA,WDAC,WO)" 2>&1
      if ($LASTEXITCODE -eq 0) {
        [void]$done.Add($p)
      } else {
        # 加 deny 失败要把所有者还回去，别留半截
        $null = & icacls $p /setowner $env:USERNAME 2>&1
        [void]$failed.Add("$p -> deny: $out")
      }
    }
    $rec = [pscustomobject]@{
      lockedAt = (Get-Date).ToString('o')
      user     = $env:USERNAME
      hard     = $true
      paths    = @($done)
    }
    $dir = Split-Path -Parent $aclRecord
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    [IO.File]::WriteAllText($aclRecord, ($rec | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
    # 2026-11-09：建一个 SYSTEM 身份的解锁任务。
    # 原因：lock 一定要管理员（setowner SYSTEM 要 SeRestorePrivilege），但退出时
    # 那个进程常常是普通权限（DSH 拉起的 node / 工具进程），takeown 拿不回 SYSTEM
    # 属主，/remove:d 就全失败——11-07 那 19 个文件就是这么留下的。
    # 有这条任务，退出方只要 schtasks /Run 就能借用 SYSTEM 身份撤锁，不弹 UAC。
    try {
      $tr = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$rootDir\acl.ps1`" unlock"
      $null = & schtasks /Create /TN 'moyu-acl-unlock' /TR $tr /SC ONCE /ST 00:00 /RU 'SYSTEM' /RL HIGHEST /F 2>&1
    } catch {}
    Write-Output ("lock: {0} paths (hard)" -f $done.Count)
    foreach ($f in $failed) { Write-Output "SKIP: $f" }
    break
  }

  'unlock' {
    if (-not (Test-Path -LiteralPath $aclRecord)) {
      Write-Output 'unlock: no record'
      break
    }
    try {
      $rec = Get-Content -LiteralPath $aclRecord -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
      Remove-Item -LiteralPath $aclRecord -Force -ErrorAction SilentlyContinue
      Write-Output 'unlock: bad record, removed'
      break
    }
    $n = 0
    $fail = 0
    $left = New-Object System.Collections.ArrayList
    # SYSTEM 任务里 $env:USERNAME 是机器账号，撤 deny 必须用记录里的账号。
    $target = if ($rec.user) { $rec.user } else { $env:USERNAME }
    foreach ($p in @($rec.paths)) {
      if (-not (Test-Path -LiteralPath $p)) { continue }
      # 所有者是 SYSTEM 时，Administrator 改不了 ACL —— 必须先 takeown 拿回来。
      # takeown 本身就会把所有者改成当前用户，所以不需要再 /setowner
      # （而且 deny 里含 WO，改所有者那步本来就该被拦）。
      $null = & takeown /f $p 2>&1
      if ($LASTEXITCODE -ne 0) { $fail++; [void]$left.Add($p); continue }
      $r = & icacls $p /remove:d $target 2>&1
      if ($LASTEXITCODE -eq 0) {
        # 属主可能是 SYSTEM（被 SYSTEM 任务 unlock 时 takeown 会改成 SYSTEM），
        # 撤完 deny 把它还原给记录的账号，免得以后连读都别扭。
        if ($rec.user -and ($rec.user -ne $env:USERNAME)) {
          $null = & icacls $p /setowner $rec.user 2>&1
        }
        $n++
      } else { $fail++; [void]$left.Add($p) }
    }
    if ($fail -gt 0) {
      # 2026-11-09：撤不掉的文件必须写回清单。之前不管成败都删清单，
      # 11-07 有 19 个文件没撤掉、清单也没了，doctor 查不出来，只剩 pack 报 EPERM。
      $rec.paths = @($left)
      $rec | Add-Member -NotePropertyName failedAt -NotePropertyValue ((Get-Date).ToString('o')) -Force
      [IO.File]::WriteAllText($aclRecord, ($rec | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
      Write-Output ("unlock: {0} paths, {1} FAILED (kept in {2})" -f $n, $fail, $aclRecord)
      foreach ($p in $left) { Write-Output "  LEFT: $p" }
      exit 1
    }
    Remove-Item -LiteralPath $aclRecord -Force -ErrorAction SilentlyContinue
    Write-Output ("unlock: {0} paths, 0 failed" -f $n)
    break
  }

  # 退出方统一走这个：先借 SYSTEM 任务撤锁（不需要管理员、不弹 UAC），
  # 撤不掉再直接撤一遍当兜底。任何一步失败都把残留写回清单。
  'unlock-safe' {
    if (-not (Test-Path -LiteralPath $aclRecord)) { Write-Output 'unlock-safe: no record'; break }
    try { $null = & schtasks /Run /TN 'moyu-acl-unlock' 2>&1 } catch {}
    for ($i = 0; $i -lt 20; $i++) {
      if (-not (Test-Path -LiteralPath $aclRecord)) { break }
      Start-Sleep -Milliseconds 300
    }
    if (-not (Test-Path -LiteralPath $aclRecord)) { Write-Output 'unlock-safe: done via task'; break }
    $self = $PSCommandPath
    if (-not $self) { $self = Join-Path $rootDir 'acl.ps1' }
    $null = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $self unlock 2>&1
    if (Test-Path -LiteralPath $aclRecord) { Write-Output 'unlock-safe: STILL LOCKED (see acl.json)'; exit 1 }
    Write-Output 'unlock-safe: done direct'
    break
  }

  # 清「没有清单的残留锁」：11-07 那批就是清单丢了、deny 还在，
  # doctor 只能报「有残留锁」却指不出是哪几个，pack 直接 EPERM。
  # 这里把受保护路径全扫一遍，带 DENY 的就 takeown + 撤 deny。
  'repair' {
    $paths = Get-ProtectedPaths
    $fixed = New-Object System.Collections.ArrayList
    $stuck = New-Object System.Collections.ArrayList
    foreach ($p in $paths) {
      if (-not (Test-Path -LiteralPath $p)) { continue }
      $acl = Get-Acl -LiteralPath $p -ErrorAction SilentlyContinue
      if (-not $acl) { continue }
      $deny = @($acl.Access | Where-Object { $_.AccessControlType -eq 'Deny' })
      if ($deny.Count -eq 0) { continue }
      $null = & takeown /f $p 2>&1
      $null = & icacls $p /remove:d $env:USERNAME 2>&1
      $acl2 = Get-Acl -LiteralPath $p -ErrorAction SilentlyContinue
      if ($acl2 -and @($acl2.Access | Where-Object { $_.AccessControlType -eq 'Deny' }).Count -eq 0) {
        [void]$fixed.Add($p)
      } else {
        [void]$stuck.Add($p)
      }
    }
    Write-Output ("repair: {0} fixed, {1} stuck" -f $fixed.Count, $stuck.Count)
    foreach ($f in $fixed) { Write-Output "  FIXED: $f" }
    foreach ($s in $stuck) { Write-Output "  STUCK: $s" }
    if ($stuck.Count -gt 0) { exit 1 }
    break
  }

  'status' {
    if (Test-Path -LiteralPath $aclRecord) {
      $rec = Get-Content -LiteralPath $aclRecord -Raw -Encoding UTF8 | ConvertFrom-Json
      Write-Output ("locked: {0}" -f $rec.lockedAt)
      foreach ($p in @($rec.paths)) { Write-Output "  $p" }
    } else {
      Write-Output 'locked: no'
    }
    break
  }
}

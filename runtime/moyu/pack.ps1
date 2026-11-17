param(
  [string]$Version = '0.1.5',
  [string]$OutDir = ''
)
$DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }


$Root = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($Root)) {
  $Root = Split-Path -Parent $MyInvocation.MyCommand.Path
}
$notebookRoot = Join-Path $env:USERPROFILE 'Desktop\摸鱼笔记'
try {
  $cfgRaw = Get-Content -LiteralPath (Join-Path $Root 'config.json') -Raw -Encoding UTF8 -ErrorAction Stop
  $cfgObj = $cfgRaw | ConvertFrom-Json
  if ($cfgObj.notebook -and $cfgObj.notebook.Trim()) { $notebookRoot = $cfgObj.notebook.Trim() }
} catch {}
$NotebookDir = Join-Path $notebookRoot '自建插件\摸鱼模式'
if ([string]::IsNullOrWhiteSpace($OutDir)) { $OutDir = $NotebookDir }
if (-not (Test-Path -LiteralPath $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }

$BadgeDir = Join-Path (Join-Path $DshHome 'plugins') 'dsh-moyu-badge'
if (-not (Test-Path -LiteralPath $BadgeDir)) { throw "badge dir not found: $BadgeDir" }

$Stage = Join-Path ([System.IO.Path]::GetTempPath()) ("moyu-pack-stage-$Version")
if (Test-Path -LiteralPath $Stage) { Remove-Item -LiteralPath $Stage -Recurse -Force }
$MoyuStage = Join-Path $Stage 'moyu'
$BadgeStage = Join-Path $Stage 'dsh-moyu-badge'
New-Item -ItemType Directory -Path (Join-Path $MoyuStage 'rules') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $MoyuStage 'tools') -Force | Out-Null
New-Item -ItemType Directory -Path $BadgeStage -Force | Out-Null

# 只带运行所需的东西；日记、状态、日志、NEXT.md 一律不进包
$payload = @('moyu.ps1', 'moyu.cmd', 'guard.mjs', 'guard.cmd', 'guard-hidden.vbs', 'exit-task.ps1', 'usage.mjs', 'gate.mjs', 'grant.mjs', 'doctor.ps1', 'doctor.cmd', 'report.ps1', 'pack.ps1', 'install.ps1', 'acl.ps1', 'acl.cmd', 'compact-diary.ps1', 'compact-diary.cmd', 'diary-guard.ps1', 'diary-guard.cmd', 'restart-dsh.ps1', 'FOR-AI.md', 'README.md', '摸鱼手册.md', '摸鱼模式-人话版.md', '边界模板.md', '踩坑与教训.md', '预约启动.md')
$copied = 0
foreach ($f in $payload) {
  $src = Join-Path $Root $f
  if (Test-Path -LiteralPath $src) {
    Copy-Item -LiteralPath $src -Destination (Join-Path $MoyuStage $f) -Force
    $copied++
  }
}
Copy-Item -LiteralPath (Join-Path $Root 'rules\mode.md') -Destination (Join-Path $MoyuStage 'rules\mode.md') -Force
# 键鼠驱动随包走：脚本自带「非摸鱼模式一律拒绝」的闸，guard.json 是它的规则表
Copy-Item -LiteralPath (Join-Path $Root 'tools\desktop.ps1') -Destination (Join-Path $MoyuStage 'tools\desktop.ps1') -Force
Copy-Item -LiteralPath (Join-Path $Root 'tools\guard.json') -Destination (Join-Path $MoyuStage 'tools\guard.json') -Force
# 玩时长采样器随包走：守夜人每 60 秒调一次，缺了它玩时长闸就等于关着
Copy-Item -LiteralPath (Join-Path $Root 'tools\playwatch.mjs') -Destination (Join-Path $MoyuStage 'tools\playwatch.mjs') -Force
# 桌面小条随包走：摸鱼时右上角显示剩余时间和已花多少钱，设置里可关
Copy-Item -LiteralPath (Join-Path $Root 'tools\moyu-float.ps1') -Destination (Join-Path $MoyuStage 'tools\moyu-float.ps1') -Force
Copy-Item -LiteralPath (Join-Path $Root 'tools\moyu-float.vbs') -Destination (Join-Path $MoyuStage 'tools\moyu-float.vbs') -Force
# 网格标定随包走：点格子前先标定，按行列算屏幕坐标，避免目测误差随缩放放大
Copy-Item -LiteralPath (Join-Path $Root 'tools\grid.mjs') -Destination (Join-Path $MoyuStage 'tools\grid.mjs') -Force
# 会话巡检随包走：查 registry 与磁盘是否一致、每条会话能不能解开；坏了可以接 QQ 报警
if (Test-Path -LiteralPath (Join-Path $Root 'tools\session-guard.mjs')) {
  Copy-Item -LiteralPath (Join-Path $Root 'tools\session-guard.mjs') -Destination (Join-Path $MoyuStage 'tools\session-guard.mjs') -Force
}
# TASKS.md 带 NUL 时会话工具改不了，用它按关键字标 done
if (Test-Path -LiteralPath (Join-Path $Root 'tools\tasks-mark.mjs')) {
  Copy-Item -LiteralPath (Join-Path $Root 'tools\tasks-mark.mjs') -Destination (Join-Path $MoyuStage 'tools\tasks-mark.mjs') -Force
}
# 2026-11-16：偏好（日记三字段）与退出摘要。这两个在 tools/ 下，payload 只管根目录，所以单列
if (Test-Path -LiteralPath (Join-Path $Root 'tools\prefs.mjs')) {
  Copy-Item -LiteralPath (Join-Path $Root 'tools\prefs.mjs') -Destination (Join-Path $MoyuStage 'tools\prefs.mjs') -Force
}
if (Test-Path -LiteralPath (Join-Path $Root 'tools\session-summary.mjs')) {
  Copy-Item -LiteralPath (Join-Path $Root 'tools\session-summary.mjs') -Destination (Join-Path $MoyuStage 'tools\session-summary.mjs') -Force
}
if (Test-Path -LiteralPath (Join-Path $Root 'tools\exit-audit.mjs')) {
  Copy-Item -LiteralPath (Join-Path $Root 'tools\exit-audit.mjs') -Destination (Join-Path $MoyuStage 'tools\exit-audit.mjs') -Force
}
# 2026-11-17：文档地图（谁负责说什么），别人拿到包也知道去哪找
if (Test-Path -LiteralPath (Join-Path $Root '文档地图.md')) {
  Copy-Item -LiteralPath (Join-Path $Root '文档地图.md') -Destination (Join-Path $MoyuStage '文档地图.md') -Force
}
if (Test-Path -LiteralPath (Join-Path $Root 'tools\diary-close.mjs')) {
  Copy-Item -LiteralPath (Join-Path $Root 'tools\diary-close.mjs') -Destination (Join-Path $MoyuStage 'tools\diary-close.mjs') -Force
}
# 2026-11-17：附带的壁纸（可选）——插件 + 一张示例壁纸，不是摸鱼必需
$wpExtra = Join-Path $Stage 'extras\wallpaper'
$wpPlugin = Join-Path (Split-Path -Parent $Root) 'plugins\dsh-ak-wallpaper'
if (Test-Path -LiteralPath $wpPlugin) {
  New-Item -ItemType Directory -Path (Join-Path $wpExtra 'dsh-ak-wallpaper') -Force | Out-Null
  Get-ChildItem -LiteralPath $wpPlugin -Force | Where-Object { $_.Name -notmatch '\.(bak|broken|try-)' } | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $wpExtra 'dsh-ak-wallpaper') -Recurse -Force -ErrorAction SilentlyContinue }
  $wpPick = Join-Path $env:USERPROFILE '.dsh\wallpaper'
  if (Test-Path -LiteralPath $wpPick) {
    New-Item -ItemType Directory -Path (Join-Path $wpExtra 'assets') -Force | Out-Null
    Get-ChildItem -LiteralPath $wpPick -File -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -like '鲸鱼码头*' -and $_.Extension -in @('.mp4', '.jpg', '.png') } |
      ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $wpExtra ('assets\' + $_.Name)) -Force }
  }
  $wpReadme = @'
# 附带的壁纸（可选）

这不是摸鱼模式的一部分，是另做的壁纸插件 dsh-ak-wallpaper 加一张示例壁纸。

装：
1. 把 dsh-ak-wallpaper 整个目录拷到 ~/.dsh/plugins/
2. 在 DSH 里启用它（它会加一个壁纸设置页）
3. 把 assets/ 里的视频或图片放进 ~/.dsh/wallpaper/，在 pick.txt 里写文件名

它的做法是「插口式」：DSH 界面越通透壁纸越明显；打不开通常是背景层的问题，先看插件自己的 README。
'@
  [System.IO.File]::WriteAllText((Join-Path $wpExtra 'README.md'), $wpReadme, (New-Object System.Text.UTF8Encoding($true)))
}

# 2026-11-17：插件自带 runtime —— 装插件就够了，不用手动铺两半
$rtBundle = Join-Path $Root 'tools\make-runtime-bundle.mjs'
$rtDst = Join-Path $BadgeStage 'runtime\moyu'
if (Test-Path -LiteralPath $rtBundle) {
  $nodeExe = 'node'
  $rtTry = Join-Path $Root 'l3-programs.json'
  if (Test-Path -LiteralPath $rtTry) {
    try { $rtCfg = Get-Content -LiteralPath $rtTry -Raw -Encoding UTF8 | ConvertFrom-Json; if ($rtCfg.node) { $nodeExe = $rtCfg.node } } catch {}
  }
  & $nodeExe $rtBundle $Root $rtDst | Out-Null
  if (Test-Path -LiteralPath $rtDst) {
    [System.IO.File]::WriteAllText((Join-Path $rtDst 'VERSION'), ($Version + "`r`n"), (New-Object System.Text.UTF8Encoding($false)))
  }
}
# 2026-11-17：报告自检 + 报告本体 + 活动报告，装到别人机器上 doctor 也要能跑这两条
foreach ($extra in @('activity-report.mjs', 'report-selftest.mjs', 'smoke.mjs')) {
  $srcExtra = Join-Path $Root ('tools\' + $extra)
  if (Test-Path -LiteralPath $srcExtra) {
    Copy-Item -LiteralPath $srcExtra -Destination (Join-Path $MoyuStage ('tools\' + $extra)) -Force
  }
}
$cfgSrc = Join-Path $Root 'config.default.json'
if (-not (Test-Path -LiteralPath $cfgSrc)) { $cfgSrc = Join-Path $Root 'config.json' }
Copy-Item -LiteralPath $cfgSrc -Destination (Join-Path $MoyuStage 'config.default.json') -Force

Get-ChildItem -LiteralPath $BadgeDir -Recurse -File | ForEach-Object {
  $rel = $_.FullName.Substring($BadgeDir.Length).TrimStart('\')
  # 不带 tests：里面的 uninstall-e2e.mjs 会调 schtasks /delete，别人误跑会删掉自己的计划任务
  if ($rel -like 'tests\*') { return }
  if ($rel -like '*.bak*') { return }   # 备份文件不进包（可移植性改动留下的副本）
  $dst = Join-Path $BadgeStage $rel
  $dir = Split-Path -Parent $dst
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  Copy-Item -LiteralPath $_.FullName -Destination $dst -Force
}

$install = @'
# dsh-moyu 摸鱼模式：安装说明

给 agent 一段自己支配的时间：有窗口、有额度、有守夜人，而且**越界会被拦**。

> **如果你能开一个 AI 会话（DSH 里就行），别自己照这份做。**
> 用仓库根目录的 `给DSH安装的话.md`：把那一整段复制给 AI，它会自己体检、装好、然后真拦一次证明生效。
> 这份文档是给「没有 AI 可用」或「AI 装到一半卡住」时手操兜底用的。

这个包会改你的机器：建两个本地账号（`moyu` 只能写游乐场、`akweb` 只能上网）、加两条防火墙规则、往 `%USERPROFILE%\.dsh\` 写文件。都能卸掉，见第五节。

---

## 一、装之前确认三件事

在 **Windows PowerShell 5.1**（不是 pwsh）里跑：

```powershell
([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole('Administrators')
$PSVersionTable.PSVersion.Major
Test-Path "$env:USERPROFILE\.dsh\profiles"
```

期望：`True`、`5`、`True`。

- 第一个不是 `True` → 用管理员身份打开 PowerShell 再来。
- 第二个不是 `5` → 你在 pwsh 里，换 `powershell.exe`。
- 第三个 `False` → DSH 还没跑起来过，先开一次。

---

## 二、装（两条路，优先第一条）

### 方式 A：从 GitHub 装（推荐，也是唯一会持续更新的路）

DSH 里 **插件 → 已安装 → 添加插件**，粘贴：

```
git+https://github.com/whale-moyu/dsh-moyu.git#<仓库里最新那个 commit 的完整 40 位 sha>
```

仓库地址：https://github.com/whale-moyu/dsh-moyu —— 首页能看到最新 commit，右键复制完整 sha。

或者用插件市场索引源（加一次，之后按名字搜）：

```
https://whale-moyu.github.io/dsh-moyu/market/index.json
```

装完**重启 DSH**。主程序会在插件第一次加载时自己铺到 `%USERPROFILE%\.dsh\moyu\`，不用手动拷。

### 方式 B：离线 zip（没有网络、GitHub 不通时）

这个 zip 是给你用的兜底，正常情况下用不上。

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.dsh\plugins\dsh-moyu-badge" | Out-Null
Copy-Item .\dsh-moyu-badge\* "$env:USERPROFILE\.dsh\plugins\dsh-moyu-badge\" -Recurse -Force
```

然后挂进 profile：`%USERPROFILE%\.dsh\profiles\<当前 profile>\package.json`，`dependencies` 加一行、`dsh.profile.bundles` 加一个名字：

```json
"dependencies": {
  "dsh-moyu-badge": "link:C:/Users/<你的用户名>/.dsh/plugins/dsh-moyu-badge"
},
"dsh": {
  "profile": {
    "bundles": ["dsh-moyu-badge"]
  }
}
```

（`bundles` 里原来有别的就保留，只在末尾加这一句；路径用正斜杠。）最后重启 DSH。

包里顶层的 `moyu\` 目录是手动检查/对照用的，正常安装**不需要**动它。

---

## 三、装完怎么知道装对了（6 项，前一项不过就别往下）

**1. 文件到位**

```powershell
Test-Path "$env:USERPROFILE\.dsh\plugins\dsh-moyu-badge\lib\index.js"
Test-Path "$env:USERPROFILE\.dsh\moyu\moyu.ps1"
```

第二个 `True` 是**插件自己把主程序铺开了**（第一次打开 DSH 之后才有，重启前没有很正常）。

**2. 插件被加载了**

设置 → 摸鱼模式，能看到 7 个页签（概览 / 时间 / 能力 / 断线 / 意愿 / 扩展 / 严格）。

看不到 → 大概率 profile 的 `package.json` 没改对，或者没重启。

**3. 体检**

```powershell
& "$env:USERPROFILE\.dsh\moyu\moyu.ps1" doctor
```

期望最后一行 `结果：N 项正常，0 项警告，0 项失败`。有几项是**可选**的（浏览器、python、隐藏启动器），缺了写「可选功能」不算失败。

**4. 两个隔离账号在**

```powershell
net user moyu
net user akweb
```

没有就补：

```powershell
& "$env:USERPROFILE\.dsh\moyu\install-l3.ps1"
& "$env:USERPROFILE\.dsh\moyu\install-web.ps1"
```

**5. 插件自检**

设置 → 摸鱼模式 → 概览 → 「跑一次自检」，六项全绿。它查的是「插件自己有没有坏」，跟体检不重复。

**6. 真拦一次（最重要）**

```powershell
& "$env:USERPROFILE\.dsh\moyu\moyu.ps1" enter -Minutes 10
```

进了摸鱼之后，让 DSH 干两件事：

- 写 `C:\Windows\test.txt` → 应被拒（回「只能写 freetime/ 和 AkPlay/」）
- 读 `%USERPROFILE%\.dsh\qq-console.json` → 应被拒

两条都被拒才算装好。然后：

```powershell
& "$env:USERPROFILE\.dsh\moyu\moyu.ps1" exit
```

---

## 四、装不上时的四种情况

**「设置里没有摸鱼模式」** → profile 的 `bundles` 没加，或加在了另一个 profile 目录。

**「doctor 报 PowerShell 语法错」** → 你用 pwsh 跑的，换 `powershell.exe`。

**「建账号失败：拒绝访问」** → 不是管理员。

**「进了摸鱼，但什么都被拒」** → 正常，默认全关。让它调 `moyu_boundary` 打开「跑」并选地盘，或去设置页「能力」里开。

---

## 五、卸掉

```powershell
& "$env:USERPROFILE\.dsh\moyu\moyu.ps1" exit
& "$env:USERPROFILE\.dsh\moyu\acl.ps1" unlock
schtasks /delete /tn moyu-guard /f
schtasks /delete /tn Moyu-AutoEnter /f
schtasks /delete /tn moyu-acl-unlock /f
Remove-NetFirewallRule -DisplayName 'Ak Moyu-NoNet','Ak Web-NoLocal' -ErrorAction SilentlyContinue
net user moyu /delete
net user akweb /delete
Remove-Item "$env:USERPROFILE\.dsh\moyu" -Recurse -Force
Remove-Item "$env:USERPROFILE\.dsh\plugins\dsh-moyu-badge" -Recurse -Force
```

最后删掉 profile `package.json` 里那两行，重启 DSH。

设置页「概览 → 卸载」按钮做的是同一件事（前七步），跑完再重启也干净。**删的是真文件，没有回收站。**

---

## 六、已知限制（先知道再用）

1. **上传只挡一半**：裸 `body` 与 `multipart` 被拦，但 HTTPS 的 body 对代理不可见，真要传还是有缝。它是减速带，不是墙。
2. **`file://` 没有系统级禁令**：这版 Edge 不执行那条策略（实测报「错误」）。现在靠两层：工具层直接拒 + 浏览器账号读不到你的目录。
3. **连续操作要一次跑完**：`moyu_desktop` 的 `seq` 能一次调用连点多下——两条命令之间隔 0.9 秒，游戏不认。

不随包分发：立绘、房间、语音模型、任何人的真实音色。想要形象，看 `moyu\摸鱼模式-人话版.md` 末尾那节（只给一个视频号）。
'@
[IO.File]::WriteAllText((Join-Path $Stage 'INSTALL.md'), $install, [Text.UTF8Encoding]::new($true))

$zip = Join-Path $OutDir ("dsh-moyu-$Version.zip")
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
Add-Type -AssemblyName System.IO.Compression | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null
# 手工建 zip 条目：条目名统一用正斜杠、中文名走 UTF-8（.NET 会置 flag bit 11）。
# Compress-Archive 与 ZipFile.CreateFromDirectory 在 .NET Framework 上都写反斜杠，
# Linux/macOS 解压会得到 "moyu\摸鱼手册.md" 这种带反斜杠的怪名字；中文名还可能不带 UTF-8 标记 → 乱码。
$fs = [System.IO.File]::Open($zip, [System.IO.FileMode]::Create)
$za = New-Object System.IO.Compression.ZipArchive($fs, [System.IO.Compression.ZipArchiveMode]::Create)
foreach ($f in (Get-ChildItem -LiteralPath $Stage -Recurse -File)) {
  $rel = $f.FullName.Substring($Stage.Length).TrimStart('\')
  $entry = $za.CreateEntry(($rel -replace '\\', '/'), [System.IO.Compression.CompressionLevel]::Optimal)
  $es = $entry.Open()
  $src = [System.IO.File]::OpenRead($f.FullName)
  $src.CopyTo($es)
  $src.Dispose(); $es.Dispose()
}
$za.Dispose(); $fs.Dispose()

$zipInfo = Get-Item -LiteralPath $zip
$stageFiles = @(Get-ChildItem -LiteralPath $Stage -Recurse -File)
$badgeFiles = @($stageFiles | Where-Object { $_.FullName -like "*dsh-moyu-badge*" })
$moyuFiles = $stageFiles.Count - $badgeFiles.Count
Remove-Item -LiteralPath $Stage -Recurse -Force -ErrorAction SilentlyContinue
Write-Output ("pack -> {0}" -f $zip)
Write-Output ("size {0:N1} KB | {1} files | moyu {2} | badge {3}" -f @(($zipInfo.Length / 1KB), ($stageFiles.Count), $moyuFiles, $badgeFiles.Count))

param(
  [string]$Cells = '',                          # "x,y;x,y;..." screen coords
  [string]$Grid  = '',                          # "c,r;c,r;..." cell coords (needs grid.mjs calibration)
  [int]$GapMs = 1600,                           # wait between towers (cooldown)
  [int]$Tower = 1,                              # 1 = arrow tower (100), 2 = gold mine (50)
  [switch]$Upgrade,                             # press Q to upgrade after placing
  [switch]$DryRun,                              # print what would happen, do not touch the mouse
  [string]$Shot = '',                           # if set, take a screenshot at the end
  [string]$ShotRect = ''                        # "rx,ry,rw,rh" crop relative to the game window
)
# Batch tower placement. Mouse only: the game ignores SendKeys for tower selection.
# The tower button is a TOGGLE, so the script first probes whether the build panel is
# open (bright pixels in the bottom-right panel area) and only clicks the button when
# it is not. After the first placement the panel stays open, so subsequent towers are
# just "click cell, click cell" (first click previews, second commits).
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, int e);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  public const uint LEFTDOWN = 0x0002, LEFTUP = 0x0004;
  public static void Click(int x, int y) {
    SetCursorPos(x, y); System.Threading.Thread.Sleep(40);
    mouse_event(LEFTDOWN, 0, 0, 0, 0);
    System.Threading.Thread.Sleep(40);
    mouse_event(LEFTUP, 0, 0, 0, 0);
  }
}
"@

$Node = 'C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$GridJs = Join-Path $PSScriptRoot 'grid.mjs'
$BtnX = 60; $BtnY = 178

# 塔按钮（左栏从上往下第 1 个）和第 2 个按钮的坐标
$Btn1 = @(60,178); $Btn2 = @(60,324)

function Get-BrightCount([int]$x, [int]$y, [int]$w, [int]$h) {
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size $w, $h))
  $n = 0
  for ($yy = 0; $yy -lt $h; $yy += 2) {
    for ($xx = 0; $xx -lt $w; $xx += 2) {
      $p = $bmp.GetPixel($xx, $yy)
      if ($p.R -gt 170 -and $p.G -gt 170 -and $p.B -gt 170) { $n++ }
    }
  }
  $g.Dispose(); $bmp.Dispose()
  return $n
}

# 右下角面板区域：面板出现时这里有白色文字/图标；未选中时是纯棋盘，亮点很少
function Test-PanelOpen {
  $c = Get-BrightCount 950 890 320 140
  return ($c -gt 60)
}

if ($Grid.Trim().Length -gt 0) {
  $parts = @()
  foreach ($c in $Grid.Split(';')) {
    $p = $c.Trim().Split(',')
    if ($p.Count -ne 2) { continue }
    $raw = & $Node $GridJs at $p[0].Trim() $p[1].Trim() 2>&1
    if ($LASTEXITCODE -ne 0) { Write-Output ("error: grid.mjs at {0},{1} -> {2}" -f $p[0], $p[1], $raw); exit 3 }
    $o = $raw | ConvertFrom-Json
    $parts += ("{0},{1}" -f $o.x, $o.y)
  }
  if ($parts.Count -eq 0) { Write-Output 'error: -Grid produced no cells'; exit 3 }
  $Cells = $parts -join ';'
  Write-Output ("grid -> {0}" -f $Cells)
}

if ($Cells.Trim().Length -eq 0) { Write-Output 'error: need -Cells or -Grid'; exit 2 }

$proc = Get-Process -Name 'Minimalist Tower Defense' -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $proc) { Write-Output 'error: game not running'; exit 2 }
[void][W]::SetForegroundWindow($proc.MainWindowHandle)
Start-Sleep -Milliseconds 350

$list = $Cells.Split(';')
if ($DryRun) {
  Write-Output ("dry-run: {0} cell(s), tower={1}, upgrade={2}, gap={3}ms, panelOpen={4}" -f $list.Count, $Tower, [bool]$Upgrade, $GapMs, (Test-PanelOpen))
  foreach ($c in $list) { Write-Output ("  would click {0}" -f $c.Trim()) }
  Write-Output 'done'
  exit 0
}

# 确保对应塔的建造面板是打开的
$btn = if ($Tower -eq 2) { $Btn2 } else { $Btn1 }
$open = Test-PanelOpen
Write-Output ("panel open before: {0}" -f $open)
if (-not $open) {
  [W]::Click($btn[0], $btn[1])
  Start-Sleep -Milliseconds 400
  $open = Test-PanelOpen
  Write-Output ("panel open after click: {0}" -f $open)
  if (-not $open) {
    [W]::Click($btn[0], $btn[1])
    Start-Sleep -Milliseconds 400
    Write-Output ("panel open after 2nd click: {0}" -f (Test-PanelOpen))
  }
}

$n = 0
foreach ($c in $list) {
  $p = $c.Trim().Split(',')
  if ($p.Count -ne 2) { continue }
  $x = [int]$p[0]; $y = [int]$p[1]
  [W]::Click($x, $y)                 # 第一次点格子：出预览
  Start-Sleep -Milliseconds 220
  [W]::Click($x, $y)                 # 第二次点同一格：确认落地
  Start-Sleep -Milliseconds 300
  if ($Upgrade) {
    [System.Windows.Forms.SendKeys]::SendWait('q')
    Start-Sleep -Milliseconds 150
  }
  $n++
  Write-Output ("placed {0}/{1} at {2},{3}" -f $n, $list.Count, $x, $y)
  Start-Sleep -Milliseconds $GapMs
}

# 收尾：取消建造态（点一次按钮）
[W]::Click($btn[0], $btn[1])
Start-Sleep -Milliseconds 200

if ($Shot.Trim().Length -gt 0) {
  $desk = Join-Path $PSScriptRoot 'desktop.ps1'
  $shotArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $desk, '-Action', 'shot',
                '-Title', 'Minimalist Tower Defense', '-Out', $Shot)
  if ($ShotRect.Trim().Length -gt 0) {
    $r = $ShotRect.Split(',')
    if ($r.Count -eq 4) { $shotArgs += @('-RX', $r[0].Trim(), '-RY', $r[1].Trim(), '-RW', $r[2].Trim(), '-RH', $r[3].Trim()) }
  }
  $out = & powershell.exe @shotArgs 2>&1
  Write-Output ("shot -> {0}" -f $Shot)
}

Write-Output 'done'

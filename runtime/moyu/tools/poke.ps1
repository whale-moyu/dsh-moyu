param(
  [Parameter(Mandatory=$true)][int]$X,
  [Parameter(Mandatory=$true)][int]$Y,
  [switch]$Force
)
# poke.ps1 - click with a stuck-detector gate (2026-11-07).
# Rule (from 9.1 of 阿鲸装身体): the same action twice is allowed; the THIRD identical click is refused.
# Pure counter, not screen hashing - Wallpaper Engine keeps the desktop moving, so pixel diff never settles.
# The screen region hash is still recorded for later inspection.
# ASCII only on purpose: PowerShell 5.1 reads this file as GBK.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class PK {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
}
"@

$stateFile = Join-Path $env:USERPROFILE '.dsh\moyu\tools\poke-state.json'
$RX = [Math]::Max(0, $X - 60); $RY = [Math]::Max(0, $Y - 60); $W = 120; $H = 120

[PK]::SetCursorPos(5, 5) | Out-Null
Start-Sleep -Milliseconds 50
$bmp = New-Object System.Drawing.Bitmap $W, $H
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($RX, $RY, 0, 0, $bmp.Size)
$g.Dispose()
$md5 = [System.Security.Cryptography.MD5]::Create()
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$hash = [BitConverter]::ToString($md5.ComputeHash($ms.ToArray())).Replace('-','').Substring(0,12)
$ms.Dispose(); $bmp.Dispose()

$prev = $null
if (Test-Path $stateFile) { try { $prev = Get-Content $stateFile -Raw | ConvertFrom-Json } catch { $prev = $null } }

$streak = 1
if ($prev -ne $null -and $prev.x -eq $X -and $prev.y -eq $Y) {
  if ($prev.streak -ne $null) { $streak = [int]$prev.streak + 1 }
}

if ($streak -ge 3 -and -not $Force) {
  Write-Output "REFUSED: ($X,$Y) clicked $($streak-1) times in a row. Third identical click blocked."
  Write-Output "STOP. Zoom-crop that area (-Zoom 3), write ONE guess + ONE piece of evidence, then change approach TYPE."
  Write-Output "If this really is a legit repeat (e.g. build-tower needs two clicks), pass -Force once."
  exit 9
}

[PK]::SetCursorPos($X, $Y) | Out-Null
Start-Sleep -Milliseconds 150
[PK]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 80
[PK]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 250

$state = [ordered]@{ x = $X; y = $Y; streak = $streak; hash = $hash; at = (Get-Date).ToString('s') }
$state | ConvertTo-Json -Compress | Set-Content -Path $stateFile -Encoding ASCII
Write-Output "clicked ($X,$Y) streak=$streak hash=$hash"

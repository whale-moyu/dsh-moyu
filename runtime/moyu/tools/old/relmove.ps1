param([int]$X, [int]$Y, [switch]$Click, [int]$Steps = 24)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class RM {
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  public struct POINT { public int X, Y; }
}
"@
$p = Get-Process | Where-Object { $_.ProcessName -like '*SlayTheSpire*' } | Select-Object -First 1
if ($p) { [RM]::SetForegroundWindow($p.MainWindowHandle) | Out-Null; Start-Sleep -Milliseconds 300 }
$c = New-Object RM+POINT
[void][RM]::GetCursorPos([ref]$c)
$dx = $X - $c.X; $dy = $Y - $c.Y
"from=$($c.X),$($c.Y) to=$X,$Y delta=$dx,$dy steps=$Steps"
for ($i = 0; $i -lt $Steps; $i++) {
  $sx = [int][math]::Round($dx / $Steps)
  $sy = [int][math]::Round($dy / $Steps)
  if ($sx -eq 0 -and $sy -eq 0) { $sx = [math]::Sign($dx); $sy = [math]::Sign($dy) }
  [RM]::mouse_event(0x0001, $sx, $sy, 0, [IntPtr]::Zero)   # MOUSEEVENTF_MOVE
  Start-Sleep -Milliseconds 12
}
Start-Sleep -Milliseconds 150
if ($Click) {
  [RM]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
  Start-Sleep -Milliseconds 80
  [RM]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
  Start-Sleep -Milliseconds 400
  'clicked'
}
$c2 = New-Object RM+POINT
[void][RM]::GetCursorPos([ref]$c2)
"final=$($c2.X),$($c2.Y)"

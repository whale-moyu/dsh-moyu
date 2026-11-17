param([int]$X, [int]$Y)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DC {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
}
"@
$p = Get-Process | Where-Object { $_.ProcessName -like '*Minimal*' } | Select-Object -First 1
[DC]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 300
[DC]::SetCursorPos($X, $Y) | Out-Null
Start-Sleep -Milliseconds 250
for ($i = 0; $i -lt 2; $i++) {
  [DC]::mouse_event(0x0002,0,0,0,[IntPtr]::Zero)
  Start-Sleep -Milliseconds 70
  [DC]::mouse_event(0x0004,0,0,0,[IntPtr]::Zero)
  Start-Sleep -Milliseconds 220
}
Start-Sleep -Milliseconds 600
"double-clicked $X,$Y"

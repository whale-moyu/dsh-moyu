param([int]$X, [int]$Y, [switch]$Click, [int]$Pause = 120)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class AM {
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT {
    public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT {
    public uint type; public MOUSEINPUT mi;
  }
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
  public struct POINT { public int X, Y; }
}
"@
$dw = [AM]::GetSystemMetrics(78)   # SM_CXVIRTUALSCREEN
$dh = [AM]::GetSystemMetrics(79)
$vx = [AM]::GetSystemMetrics(76)
$vy = [AM]::GetSystemMetrics(77)
$ax = [int](($X - $vx) * 65535 / ($dw - 1))
$ay = [int](($Y - $vy) * 65535 / ($dh - 1))
$inp = New-Object 'AM+INPUT[]' 1
$inp[0].type = 0
$inp[0].mi.dx = $ax
$inp[0].mi.dy = $ay
$inp[0].mi.dwFlags = 0x0001 -bor 0x8000   # MOVE | ABSOLUTE(no virtualdesk needed since normalized to virtual)
$r = [AM]::SendInput(1, $inp, [System.Runtime.InteropServices.Marshal]::SizeOf([type]'AM+INPUT'))
Start-Sleep -Milliseconds $Pause
$c = New-Object AM+POINT
[void][AM]::GetCursorPos([ref]$c)
"sendinput=$r want=$X,$Y got=$($c.X),$($c.Y) vdesk=$vx,$vy ${dw}x${dh}"
if ($Click) {
  $d = New-Object 'AM+INPUT[]' 2
  for ($i = 0; $i -lt 2; $i++) { $d[$i].type = 0; $d[$i].mi.dwFlags = $(if ($i -eq 0) { 0x0002 } else { 0x0004 }) }
  [void][AM]::SendInput(2, $d, [System.Runtime.InteropServices.Marshal]::SizeOf([type]'AM+INPUT'))
  Start-Sleep -Milliseconds 150
  'clicked'
}

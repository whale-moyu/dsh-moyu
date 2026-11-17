u{FEFF}# remote-invoke.ps1 -- "click without touching the mouse" (AI probe + UIA/window message)
# usage: powershell -File remote-invoke.ps1 -Hwnd 0x1234 -X 800 -Y 600 [-Probe 900] [-NoProbe]
# returns one JSON line: {"ok":true,"method":"InvokePattern","element":"Button 'OK'","x":..,"y":..}
# ASCII only on purpose: powershell 5.1 reads BOM-less UTF-8 as ANSI.

param(
    [Parameter(Mandatory = $true)][Int64]$Hwnd,
    [Parameter(Mandatory = $true)][int]$X,
    [Parameter(Mandatory = $true)][int]$Y,
    [int]$Probe = 900,
    [switch]$NoProbe
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase, System.Drawing

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class RemWin {
  [StructLayout(LayoutKind.Sequential)] public struct PT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(PT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
  [DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr h, ref PT p);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(IntPtr h, uint msg, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr res);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public const uint WM_LBUTTONDOWN = 0x0201;
  public const uint WM_LBUTTONUP = 0x0202;
  public const uint WM_MOUSEMOVE = 0x0200;
  public const uint MK_LBUTTON = 0x0001;
  public static IntPtr LP(int x, int y) { return (IntPtr)((y << 16) | (x & 0xFFFF)); }
  public static IntPtr TopLevel(IntPtr h) { return GetAncestor(h, 2); }
}
'@

$result = @{ ok = $false; method = 'none'; element = ''; x = $X; y = $Y; why = '' }

# ---- 1. probe ring ------------------------------------------------------------
if (-not $NoProbe) {
    $toolDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    $req = Join-Path $toolDir 'cursor-req.json'
    "{`"x`":$X,`"y`":$Y,`"ms`":$Probe}" | Set-Content -LiteralPath $req -Encoding ASCII
    $running = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
        Where-Object { $_.CommandLine -and $_.CommandLine -like '*cursor-overlay.ps1*' })
    if ($running.Count -eq 0) {
        Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList @(
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $toolDir 'cursor-overlay.ps1')
        ) | Out-Null
    }
    Start-Sleep -Milliseconds 260
}

$target = [IntPtr]$Hwnd

# ---- 2. UIA: element at point, then a pattern that does not need the mouse ----
function Try-Pattern($el, $name) {
    try {
        $p = $null
        switch ($name) {
            'Invoke' { $p = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern) }
            'Toggle' { $p = $el.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern) }
            'SelectionItem' { $p = $el.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern) }
            'ExpandCollapse' { $p = $el.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern) }
        }
        if ($null -eq $p) { return $false }
        switch ($name) {
            'Invoke' { $p.Invoke() }
            'Toggle' { $p.Toggle() }
            'SelectionItem' { $p.Select() }
            'ExpandCollapse' {
                if ($p.Current.ExpandCollapseState -eq [System.Windows.Automation.ExpandCollapseState]::Expanded) { $p.Collapse() } else { $p.Expand() }
            }
        }
        return $true
    } catch { return $false }
}

try {
    $pt = New-Object System.Windows.Point($X, $Y)
    $el = [System.Windows.Automation.AutomationElement]::FromPoint($pt)
    $depth = 0
    while ($el -and $depth -lt 6) {
        foreach ($name in @('Invoke', 'Toggle', 'SelectionItem', 'ExpandCollapse')) {
            if (Try-Pattern $el $name) {
                $result.ok = $true
                $result.method = $name + 'Pattern'
                $result.element = ($el.Current.ControlType.ProgrammaticName + ' ' + $el.Current.Name)
                $result | ConvertTo-Json -Compress
                exit 0
            }
        }
        $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
        $el = $walker.GetParent($el)
        $depth++
    }
    $result.why = 'no-uia-pattern'
} catch {
    $result.why = 'uia-error: ' + $_.Exception.Message
}

# ---- 3. fallback: window message (the window still never gets the cursor) -----
try {
    $p = New-Object RemWin+PT
    $p.X = $X; $p.Y = $Y
    $under = [RemWin]::WindowFromPoint($p)
    if ($under -eq [IntPtr]::Zero) { $under = $target }
    $cp = New-Object RemWin+PT
    $cp.X = $X; $cp.Y = $Y
    [void][RemWin]::ScreenToClient($under, [ref]$cp)
    $lp = [RemWin]::LP($cp.X, $cp.Y)
    [void][RemWin]::PostMessage($under, [RemWin]::WM_MOUSEMOVE, [IntPtr]::Zero, $lp)
    Start-Sleep -Milliseconds 30
    [void][RemWin]::PostMessage($under, [RemWin]::WM_LBUTTONDOWN, [IntPtr][RemWin]::MK_LBUTTON, $lp)
    Start-Sleep -Milliseconds 40
    [void][RemWin]::PostMessage($under, [RemWin]::WM_LBUTTONUP, [IntPtr]::Zero, $lp)
    $result.ok = $true
    $result.method = 'window-message'
    $result.element = 'hwnd 0x' + ('{0:X}' -f $under.ToInt64()) + ' client ' + $cp.X + ',' + $cp.Y
} catch {
    $result.ok = $false
    $result.why = ($result.why + ' | post-error: ' + $_.Exception.Message)
}

$result | ConvertTo-Json -Compress
if ($result.ok) { exit 0 } else { exit 2 }

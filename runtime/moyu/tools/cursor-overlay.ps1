# cursor-overlay.ps1 -- shows a small probe ring where the AI is about to click.
# Resident process. Reads ~/.dsh/moyu/tools/cursor-req.json every 120ms:
#   { "x": 123, "y": 456, "ms": 900 }
# Ring fades out after ms. Click-through, topmost, never takes focus.
# ASCII only on purpose: powershell 5.1 reads BOM-less UTF-8 as ANSI.

param([string]$State = '')

Add-Type -AssemblyName System.Windows.Forms, System.Drawing

$toolDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $State) { $State = Join-Path $toolDir 'cursor-req.json' }

$mutex = New-Object System.Threading.Mutex($false, 'Global\AkCursorOverlay')
if (-not $mutex.WaitOne(0)) { exit 0 }

Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class CurW {
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int i, int v);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  public const int GWL_EXSTYLE = -20;
  public const int WS_EX_TRANSPARENT = 0x20;
  public const int WS_EX_TOOLWINDOW = 0x80;
  public const int WS_EX_NOACTIVATE = 0x08000000;
  public const int WS_EX_LAYERED = 0x80000;
  public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
  public const uint SWP_NOMOVE = 0x2, SWP_NOSIZE = 0x1, SWP_NOACTIVATE = 0x10;
}
'@

$size = 64
$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$form.ShowInTaskbar = $false
$form.TopMost = $true
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$form.Width = $size
$form.Height = $size
$form.BackColor = [System.Drawing.Color]::Black
$form.TransparencyKey = [System.Drawing.Color]::Black
$form.Opacity = 0.92
$form.Visible = $false

$form.Add_Paint({
    param($s, $e)
    $g = $e.Graphics
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(235, 120, 200, 255)), 3
    $g.DrawEllipse($pen, 8, 8, $size - 17, $size - 17)
    $g.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(200, 120, 200, 255))), ($size/2 - 4), ($size/2 - 4), 8, 8)
    $pen.Dispose()
})

$form.Add_Shown({
    $h = $form.Handle
    $ex = [CurW]::GetWindowLong($h, [CurW]::GWL_EXSTYLE)
    $ex = $ex -bor [CurW]::WS_EX_TRANSPARENT -bor [CurW]::WS_EX_TOOLWINDOW -bor [CurW]::WS_EX_NOACTIVATE -bor [CurW]::WS_EX_LAYERED
    [void][CurW]::SetWindowLong($h, [CurW]::GWL_EXSTYLE, $ex)
    [void][CurW]::SetWindowPos($h, [CurW]::HWND_TOPMOST, 0, 0, 0, 0, ([CurW]::SWP_NOMOVE -bor [CurW]::SWP_NOSIZE -bor [CurW]::SWP_NOACTIVATE))
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 120
$last = ''
$hideAt = [datetime]::MinValue
# 2026-11-07: 不再常驻。多久没收到请求就自己退出，免得桌面永远挂着一个看不见的置顶窗。
$lastReqAt = Get-Date
$idleSec = 120

$timer.Add_Tick({
    try {
        if ((Test-Path $State) -and ($hideAt -eq [datetime]::MinValue -or (Get-Date) -gt $hideAt)) {
            $raw = Get-Content -LiteralPath $State -Raw -ErrorAction SilentlyContinue
            if ($raw -and $raw -ne $last -and ($this.Tag -eq $null -or $this.Tag -ne $raw)) {
                $this.Tag = $raw
                $last = $raw
                $o = $raw | ConvertFrom-Json
                $ms = 900
                if ($o.ms) { $ms = [int]$o.ms }
                $form.Left = [int]$o.x - [int]($size / 2)
                $form.Top = [int]$o.y - [int]($size / 2)
                $form.Visible = $true
                $form.TopMost = $true
                $hideAt = (Get-Date).AddMilliseconds($ms)
                $lastReqAt = Get-Date
                return
            }
        }
        if ($form.Visible -and $hideAt -ne [datetime]::MinValue -and (Get-Date) -gt $hideAt) {
            $form.Visible = $false
            $hideAt = [datetime]::MinValue
            $last = ''
        }
        if (((Get-Date) - $lastReqAt).TotalSeconds -gt $idleSec) {
            $form.Close()
        }
    } catch { }
})

$timer.Start()
[System.Windows.Forms.Application]::Run($form)
$mutex.ReleaseMutex()

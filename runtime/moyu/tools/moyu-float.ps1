param([string]$StateFile = '', [string]$ConfigFile = '')

# 单实例：重复启动直接退出（vbs 每次进摸鱼都会被叫一遍）
$mutex = New-Object System.Threading.Mutex($false, 'Global\MoyuFloatPill')
try { $got = $mutex.WaitOne(0) } catch { $got = $false }
if (-not $got) { exit 0 }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# 取前台窗口句柄，用来判断「现在人在哪块屏」
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MoyuFloatNative {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]
  public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int pid);
}
'@

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
if (-not $StateFile) { $StateFile = Join-Path $dshHome 'moyu\state.json' }
if (-not $ConfigFile) { $ConfigFile = Join-Path $dshHome 'moyu\config.json' }

$form = New-Object System.Windows.Forms.Form
$form.Text = 'moyu-float'
$form.FormBorderStyle = 'None'
$form.StartPosition = 'Manual'
$form.ShowInTaskbar = $false
$form.TopMost = $true
$form.BackColor = [System.Drawing.Color]::FromArgb(22, 22, 22)
$form.Opacity = 0.93
$form.Width = 340
$form.Height = 52

$lbl = New-Object System.Windows.Forms.Label
$lbl.Dock = 'Fill'
$lbl.TextAlign = 'MiddleCenter'
$lbl.ForeColor = [System.Drawing.Color]::White
$lbl.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 10.5, [System.Drawing.FontStyle]::Bold)
$lbl.BackColor = [System.Drawing.Color]::Transparent
$lbl.Cursor = 'Hand'
$form.Controls.Add($lbl)

$script:lastScreen = ''

# 贴在「当前前台窗口所在的显示器」右上角；换屏 / 换分辨率都会跟着走
function Place-OnActiveScreen {
    try {
        $hwnd = [MoyuFloatNative]::GetForegroundWindow()
        if ($hwnd -eq [IntPtr]::Zero) { return }
        $scr = [System.Windows.Forms.Screen]::FromHandle($hwnd)
        if (-not $scr) { return }
        $wa = $scr.WorkingArea
        $left = $wa.Right - $form.Width - 20
        $top = $wa.Top + 20
        $key = "$($scr.DeviceName):$left,$top"
        if ($key -ne $script:lastScreen) {
            $script:lastScreen = $key
            $form.Left = $left
            $form.Top = $top
        }
    } catch { }
}

function Get-FloatEnabled {
    try {
        if (-not (Test-Path -LiteralPath $ConfigFile)) { return $true }
        $cfgRaw = [IO.File]::ReadAllText($ConfigFile)
        if ($cfgRaw -match '"float"\s*:\s*\{[^}]*"enabled"\s*:\s*(true|false)') { return ($Matches[1] -eq 'true') }
        return $true
    } catch { return $true }
}

function Test-DshForeground {
    try {
        $hwnd = [MoyuFloatNative]::GetForegroundWindow()
        if ($hwnd -eq [IntPtr]::Zero) { return $false }
        $fpid = 0
        [void][MoyuFloatNative]::GetWindowThreadProcessId($hwnd, [ref]$fpid)
        if ($fpid -le 0) { return $false }
        $fp = Get-Process -Id $fpid -ErrorAction Stop
        return ($fp.ProcessName -like 'DeepSeek*')
    } catch { return $false }
}

function Update-Float {
    try {
        if (-not (Get-FloatEnabled)) {
            if ($form.Visible) { $form.Hide() }
            return
        }
        if (Test-DshForeground) {
            if ($form.Visible) { $form.Hide() }
            return
        }
        if (-not (Test-Path -LiteralPath $StateFile)) {
            if ($form.Visible) { $form.Hide() }
            return
        }
        $raw = [IO.File]::ReadAllText($StateFile)
        $mode = ''
        if ($raw -match '"mode"\s*:\s*"([^"]*)"') { $mode = $Matches[1] }
        if ($mode -eq 'moyu') {
            $cap = 0.0; $used = 0.0
            if ($raw -match '"budgetYuan"\s*:\s*(-?[0-9.]+)') { $cap = [double]::Parse($Matches[1], [Globalization.CultureInfo]::InvariantCulture) }
            if ($raw -match '"budgetUsed"\s*:\s*(-?[0-9.]+)') { $used = [double]::Parse($Matches[1], [Globalization.CultureInfo]::InvariantCulture) }
            $rest = ''
            if ($raw -match '"sessionEnds"\s*:\s*"([^"]*)"') {
                try {
                    $end = [datetime]::Parse($Matches[1], [Globalization.CultureInfo]::CurrentCulture)
                    $mm = ($end - (Get-Date)).TotalMinutes
                    if ($mm -gt 0) { $rest = '剩 ' + [math]::Ceiling($mm) + ' 分' } else { $rest = '已到点' }
                } catch { }
            }
            $lbl.Text = '摸鱼中 · ' + $rest + ' · ' + $used.ToString('0.00') + '/' + $cap.ToString('0.00') + ' 元'
            $lbl.ForeColor = [System.Drawing.Color]::FromArgb(240, 190, 120)
            if (-not $form.Visible) { $form.Show() }
            Place-OnActiveScreen
        } else {
            if ($form.Visible) { $form.Hide() }
        }
    } catch {
        $lbl.Text = '读状态出错：' + $_.Exception.GetType().Name
        $lbl.ForeColor = [System.Drawing.Color]::IndianRed
        if (-not $form.Visible) { $form.Show() }
    }
}

Update-Float

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$timer.Add_Tick({ Update-Float })
$timer.Start()

$lbl.Add_DoubleClick({ $form.Close() })
$form.Add_DoubleClick({ $form.Close() })

[void]$form.Show()
[System.Windows.Forms.Application]::Run($form)

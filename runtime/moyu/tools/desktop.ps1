#requires -Version 5.1
<#
  desktop.ps1 - minimal, removable keyboard/mouse driver for this machine.

  Actions
    windows                     list visible top-level windows (hwnd, title, rect)
    rect    -Title <substr>     show the rect of the first matching window
    focus   -Title <substr>     bring window to foreground (ALT-tap + AttachThreadInput)
    click   -X n -Y n           absolute screen click
    clickwin -Title <s> -RX n -RY n   click relative to the window's top-left
    move    -X n -Y n           move the cursor only
    type    -Text "<text>"      type unicode text in ONE SendInput batch
    key     -Keys "ctrl+s"      press a key combination
    wheel   -Delta n [-X n -Y n] [-Horizontal]
            mouse wheel; positive = away from user (up). Optional move first.
    rdrag   -DX n -DY n [-X n -Y n] [-Steps n]
            right-button drag from the current point (or -X -Y) by DX,DY. Map pan.
    rclick  -X n -Y n           right click
    mdown / mup [-Right]        press / release a mouse button (for drag flows)
    shot    -Out <file> [-Title <s>] [-RX n -RY n [-RW n -RH n]] [-Zoom 1..4] [-Jpeg]
            screenshot (window rect or full screen), optional crop and zoom.
            Without -Zoom the long edge is capped at -MaxEdge (default 1280),
            which keeps the image under the viewer's downscale threshold.
            Default output goes to ~/.dsh/playground/shots/.
            Since 2026-11-02 a shot obeys a capture zone: it refuses when a
            visible window overlapping the frame belongs to a secret-keeping
            process (credentials / lock screen / remote session), listed as
            shotForbidProcesses in guard.json (built-in default used when the
            key is absent).  allowApps is not applied to captures: they only
            read, they cannot change anything.
    ocr     -Path <image>       read the text out of a picture with the OCR
                                engine that ships with Windows (offline, no
                                install). -DryRun only resolves the path.
    shot -Ocr ...               after the screenshot, also OCR it: the text
                                (kept at full size -- no -MaxEdge downscale)
                                goes into the result and a sidecar .txt is
                                written next to the image.

  Flags
    -DryRun        resolve everything, inject nothing
    -Log <path>    action log (default ~/.dsh/tools/actions.log)
    -NoLog

  Emergency stop: create the file ~/.dsh/tools/STOP and every action is refused.

  Design notes
    * one SendInput call per logical action -> fast, atomic
    * DPI awareness is set to PER_MONITOR_AWARE_V2 before any coordinate is used
    * SetForegroundWindow alone usually fails; we do ALT tap + AttachThreadInput
    * no service, no registry, no install: delete this file and it is gone
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Action,
    [string]$Title,
    [string]$Text,
    [string]$Keys,
    [string]$Out,
    [string]$Path,
    [switch]$Ocr,
    [int]$X = [int]::MinValue,
    [int]$Y = [int]::MinValue,
    [int]$RX = 0,
    [int]$RY = 0,
    [int]$RW = 0,
    [int]$RH = 0,
    [int]$Zoom = 1,
    [int]$MaxEdge = 1280,
    [switch]$Jpeg,
    [int]$Delta = 0,
    [int]$DX = 0,
    [int]$DY = 0,
    [int]$Steps = 12,
    [switch]$Right,
    [switch]$Horizontal,
    [string]$Focus,
    [int]$DelayMs = 15,
    [switch]$DryRun,
    [string]$Log,
    [switch]$NoLog,
    [string]$Seq
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
$ToolDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$MoyuDirTop = Split-Path -Parent $ToolDir
$PlaygroundDir = Join-Path (Split-Path -Parent $MoyuDirTop) 'playground'
if (-not $Log) { $Log = Join-Path $ToolDir 'actions.log' }
$StopFlag = Join-Path $ToolDir 'STOP'
function Write-Act {
    param([string]$msg)
    if ($NoLog) { return }
    try {
        $line = ('{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg)
        [IO.File]::AppendAllText($Log, $line + "`r`n", [Text.UTF8Encoding]::new($false))
    } catch { }
}

if (Test-Path $StopFlag) {
    Write-Act 'REFUSED stop-flag-present'
    Write-Output 'stopped: remove desktop STOP flag first'
    exit 3
}

# ---- guard: layer 1 (hard-coded forbidden zones + app allowlist) ----
# Rules live in guard.json next to this script.  Default deny when the allowlist
# is non-empty: only processes listed in allowApps may receive input.
$GuardFile = Join-Path $ToolDir 'guard.json'
$BoundaryLog = Join-Path $ToolDir 'boundary.log'

$Guard = [ordered]@{
    enabled         = $true
    forbidProcesses = @('DeepSeek Harness', '1Password', 'Bitwarden', 'KeePass', 'keepass', 'consent', 'LogonUI', 'LockApp', 'CredentialUIBroker', 'SecurityHealthUI')
    allowApps       = @()   # 兜底空表：guard.json 读不出来时，一个都不许点
    rateLimit       = $null
    actionQuota     = $null
}
if (Test-Path -LiteralPath $GuardFile) {
    try {
        $gj = [IO.File]::ReadAllText($GuardFile, [Text.UTF8Encoding]::new($false)) | ConvertFrom-Json
        $Guard.enabled = [bool]$gj.enabled
        $Guard.forbidProcesses = @($gj.forbidProcesses)
        $Guard.allowApps = @($gj.allowApps)
        if ($gj.boundaryLog) { $BoundaryLog = [string]$gj.boundaryLog }
        if ($gj.rateLimit) { $Guard.rateLimit = $gj.rateLimit }
        if ($gj.actionQuota) { $Guard.actionQuota = $gj.actionQuota }
    } catch {
        Write-Act 'REFUSED guard-config-unreadable'
        Write-Output ('refused: guard.json unreadable (' + $_.Exception.Message + ')')
        exit 5
    }
}

# ---- boundary log -------------------------------------------------------
# One line per attempt, refused or cooled.  Format:
#   yyyy-MM-dd HH:mm:ss | layer=N | kind=xxx | what=xxx | why=xxx | result=refused|cooled
# layer 1 = hard process zone, 2 = moyu whole-class switch, 4 = rate limit, 6 = default deny
function Get-RefusalKind {
    param([string]$what)
    $i = $what.IndexOf(':')
    if ($i -gt 0) { return $what.Substring(0, $i) }
    return $what
}
function Get-RefusalLayer {
    param([string]$why)
    if ($why -like 'forbidden-process:*' -or $why -like 'forbidden-process-in-frame:*' -or $why -eq 'target-process-unknown' -or $why -eq 'type-target-not-foreground' -or $why -like 'not-in-allowlist:*') { return 1 }
    if ($why -like 'moyu-boundary-*' -or $why -like 'not-in-moyu*') { return 2 }
    if ($why -like 'quota-exceeded:*') { return 3 }
    if ($why -like 'rate-limit:*') { return 4 }
    return 6
}
function Get-BoundaryLines {
    if (-not (Test-Path -LiteralPath $BoundaryLog)) { return @() }
    try { return @([IO.File]::ReadAllLines($BoundaryLog, [Text.UTF8Encoding]::new($false))) } catch { return @() }
}
function Test-RateLimited {
    param([string]$kind)
    $rl = $Guard.rateLimit
    if (-not $rl -or -not $rl.maxPerWindow) { return $false }
    $windowMin = 60
    if ($rl.windowMin) { $windowMin = [int]$rl.windowMin }
    $coolMin = 15
    if ($rl.coolDownMin) { $coolMin = [int]$rl.coolDownMin }
    $max = [int]$rl.maxPerWindow
    $now = Get-Date
    $count = 0
    $lastRefused = $null
    foreach ($l in (Get-BoundaryLines)) {
        if ($l -notlike ('*| kind=' + $kind + ' |*')) { continue }
        if ($l -notlike '*result=refused*') { continue }
        $ts = $null
        try { $ts = [datetime]::ParseExact($l.Substring(0, 19), 'yyyy-MM-dd HH:mm:ss', $null) } catch { continue }
        if (($now - $ts).TotalMinutes -gt $windowMin) { continue }
        $count++
        if (-not $lastRefused -or $ts -gt $lastRefused) { $lastRefused = $ts }
    }
    if ($count -lt $max) { return $false }
    if ($lastRefused -and ($now - $lastRefused).TotalMinutes -lt $coolMin) { return $true }
    return ($count -ge $max)
}
# ---- action quota (2026-11-02) -------------------------------------------
# Rate limiting counts *refusals*; this counts *successful* injections.  A
# legal-but-frantic loop (500 clicks inside one wake) used to pass unchecked.
# The window is rolling-ish: it resets windowMin minutes after the first
# action of the window, so it bounds throughput without needing a wake id.
$QuotaFile = Join-Path $ToolDir 'quota-state.json'
function Test-ActionQuota {
    param([string]$what)
    $q = $Guard.actionQuota
    if (-not $q -or -not $q.maxPerWindow) { return }
    $max = [int]$q.maxPerWindow
    $windowMin = 60
    if ($q.windowMin) { $windowMin = [int]$q.windowMin }
    $now = Get-Date
    $start = $now
    $count = 0
    if (Test-Path -LiteralPath $QuotaFile) {
        try {
            $st = [IO.File]::ReadAllText($QuotaFile, [Text.UTF8Encoding]::new($false)) | ConvertFrom-Json
            if ($st -and $st.windowStart) { $start = [datetime]::Parse([string]$st.windowStart) }
            if ($st -and $st.count) { $count = [int]$st.count }
        } catch { $start = $now; $count = 0 }
    }
    if (($now - $start).TotalMinutes -ge $windowMin) { $start = $now; $count = 0 }
    if ($count -ge $max) {
        Refuse-Action $what ('quota-exceeded:' + $count + '/' + $max + 'in' + $windowMin + 'min')
    }
    $state = [ordered]@{ windowStart = $start.ToString('o'); count = ($count + 1) }
    try { [IO.File]::WriteAllText($QuotaFile, ($state | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false)) } catch { }
}

# ---- app allowlist matching (2026-11-02) --------------------------------
# Exact match on process name / exe stem / exe filename; '*' allowed as a
# wildcard.  The old substring test let any process whose name merely
# *contained* "notepad" receive input.
function Test-WildcardMatch {
    param([string]$value, [string]$pattern)
    if (-not $value -or -not $pattern) { return $false }
    $v = $value.ToLower()
    $p = $pattern.ToLower()
    if (-not $p.Contains('*')) { return ($v -eq $p) }
    $rx = '^' + ([regex]::Escape($p)).Replace('\*', '.*') + '$'
    return [regex]::IsMatch($v, $rx)
}
function Test-AppAllowed {
    param([string]$name, [string]$stem, [string]$file, [string[]]$patterns)
    foreach ($a in $patterns) {
        if (-not $a) { continue }
        if (Test-WildcardMatch $name $a) { return $true }
        if (Test-WildcardMatch $stem $a) { return $true }
        if (Test-WildcardMatch $file $a) { return $true }
    }
    return $false
}

function Write-Boundary {
    param([string]$what, [string]$why, [string]$result, [int]$layerOverride = -1)
    $kind = Get-RefusalKind $what
    if ($layerOverride -ge 0) { $layer = $layerOverride } else { $layer = Get-RefusalLayer $why }
    $line = ('{0} | layer={1} | kind={2} | what={3} | why={4} | result={5}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $layer, $kind, $what, $why, $result)
    try { [IO.File]::AppendAllText($BoundaryLog, $line + "`r`n", [Text.UTF8Encoding]::new($false)) } catch { }
}

function Refuse-Action {
    param([string]$what, [string]$why)
    $kind = Get-RefusalKind $what
    if (Test-RateLimited $kind) {
        Write-Boundary $what 'rate-limit:cooled' 'cooled'
        Write-Act ('COOLED ' + $what + ' :: rate-limit')
        Write-Output ('refused: rate-limit: too many attempts of this kind (' + $kind + ') in the last hour; cooling down')
        exit 6
    }
    Write-Boundary $what $why 'refused'
    Write-Act ('REFUSED ' + $what + ' :: ' + $why)
    Write-Output ('refused: ' + $why)
    exit 4
}

function Get-TargetProcess {
    param([IntPtr]$handle)
    if ($handle -eq [IntPtr]::Zero) { return $null }
    $procId = [uint32]0
    [void][Desk]::GetWindowThreadProcessId($handle, [ref]$procId)
    if ($procId -eq 0) { return $null }
    $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if (-not $p) { return $null }
    $path = ''
    try { $path = $p.Path } catch { }
    return [pscustomobject]@{ Id = $procId; Name = $p.ProcessName; Path = $path; Title = [Desk]::TitleOf($handle) }
}

function Assert-Guard {
    param([IntPtr]$handle, [string]$what, [switch]$ReadOnly)
    if (-not $Guard.enabled) { return }
    $p = Get-TargetProcess $handle
    if (-not $p) { Refuse-Action $what 'target-process-unknown' }
    $id = ($p.Name + ' ' + [IO.Path]::GetFileNameWithoutExtension($p.Path)).ToLower()
    foreach ($bad in $Guard.forbidProcesses) {
        if ($bad -and $id.Contains($bad.ToLower())) { Refuse-Action $what ('forbidden-process:' + $p.Name) }
    }
    # 2026-11-08: read-only actions (move/wheel) are allowed over any window --
    # seeing is not touching.  They still refuse the 26 forbidden processes,
    # but they no longer need to be on the app allowlist.
    if (-not $ReadOnly -and $Guard.allowApps.Count -gt 0) {
        $stem = ''
        $file = ''
        if ($p.Path) {
            $stem = [IO.Path]::GetFileNameWithoutExtension($p.Path)
            $file = [IO.Path]::GetFileName($p.Path)
        }
        if (-not (Test-AppAllowed $p.Name $stem $file $Guard.allowApps)) { Refuse-Action $what ('not-in-allowlist:' + $p.Name) }
    }
}

# ---- shot guard (2026-11-02) --------------------------------------------
# Seeing a password manager is as bad as typing into it, but a capture only
# *reads*: it cannot change anything.  So the capture zone is narrower than the
# input zone -- it refuses only what must stay secret (credentials, lock/login
# screens, remote sessions), and it does not apply allowApps (a screenshot of
# my own DSH window or of a terminal is legitimate).
$ShotForbid = @(
    '1Password', 'Bitwarden', 'KeePass', 'keepass', 'consent',
    'LogonUI', 'LockApp', 'CredentialUIBroker', 'UserAccountControlSettings',
    'SecurityHealthUI', 'mstsc', 'quickassist'
)
if ($gj -and $gj.shotForbidProcesses) { $ShotForbid = @($gj.shotForbidProcesses) }
function Get-ForbiddenOwner {
    param([IntPtr]$handle, [string[]]$rules)
    $p = Get-TargetProcess $handle
    if (-not $p) { return $null }
    $id = ($p.Name + ' ' + [IO.Path]::GetFileNameWithoutExtension($p.Path)).ToLower()
    foreach ($bad in $rules) {
        if ($bad -and $id.Contains($bad.ToLower())) { return $p.Name }
    }
    return $null
}
function Assert-ShotClear {
    param([int]$x, [int]$y, [int]$w, [int]$h, [string]$what)
    if (-not $Guard.enabled) { return }
    if ($w -le 0 -or $h -le 0) { return }
    foreach ($hw in [Desk]::AllWindows()) {
        $r = [Desk]::RectOf($hw)
        if ($r[2] -le 0 -or $r[3] -le 0) { continue }
        $ox = [Math]::Max($x, $r[0]); $oy = [Math]::Max($y, $r[1])
        $ex = [Math]::Min($x + $w, $r[0] + $r[2]); $ey = [Math]::Min($y + $h, $r[1] + $r[3])
        if ($ex -le $ox -or $ey -le $oy) { continue }
        $bad = Get-ForbiddenOwner $hw $ShotForbid
        if ($bad) { Refuse-Action $what ('forbidden-process-in-frame:' + $bad) }
    }
}

# ---- OCR (2026-11-05): read text out of a picture, offline ----------------
# Windows ships the engine (Windows.Media.Ocr); nothing to install.  A capture
# only *reads*, so the capture zone applies, allowApps does not -- same rule
# as shot.  Text comes back as one string in reading order.
function Invoke-Ocr {
    param([string]$ImagePath)
    if (-not $ImagePath) { throw 'ocr needs -Path <image file>' }
    $full = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($ImagePath)
    if (-not (Test-Path -LiteralPath $full)) { throw ('image not found: ' + $full) }
    if ($DryRun) { return [pscustomobject]@{ DryRun = $true; Path = $full; Chars = 0; Lines = 0; Text = '' } }
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $bridge = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]
    if (-not $bridge) { throw 'WinRT AsTask bridge unavailable' }
    $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
    $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
    $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
    $null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
    $engine = $null
    foreach ($tag in @('zh-Hans-CN', 'zh-Hans', 'en-US')) {
        try {
            $lang = New-Object Windows.Globalization.Language $tag
            $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
        } catch { $engine = $null }
        if ($engine) { break }
    }
    if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
    if (-not $engine) { throw 'no OCR language pack installed' }
    function Await-Op($op, $type) {
        $task = $bridge.MakeGenericMethod($type).Invoke($null, @($op))
        $task.Wait(-1) | Out-Null
        if ($task.IsFaulted) { throw $task.Exception.InnerException }
        $task.Result
    }
    # small captures OCR poorly; a 2x upscale is the sweet spot (tested on
    # notepad-sized UI text: 1x garbles the CJK, 2x reads it, 3x starts losing
    # lines again).  Everything stays local and the temp file is removed.
    $ocrPath = $full
    $scaledTmp = $null
    try {
        Add-Type -AssemblyName System.Drawing
        $probe = [System.Drawing.Bitmap]::FromFile($full)
        if ($probe.Width -lt 1000) {
            $nw = $probe.Width * 2; $nh = $probe.Height * 2
            $big = New-Object System.Drawing.Bitmap $nw, $nh
            $bg = [System.Drawing.Graphics]::FromImage($big)
            $bg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $bg.DrawImage($probe, 0, 0, $nw, $nh)
            $bg.Dispose()
            $scaledTmp = Join-Path ([IO.Path]::GetTempPath()) ('ocr-' + [guid]::NewGuid().ToString('N') + '.png')
            $big.Save($scaledTmp, [System.Drawing.Imaging.ImageFormat]::Png)
            $big.Dispose()
            $ocrPath = $scaledTmp
        }
        $probe.Dispose()
    } catch { $ocrPath = $full }
    $file = Await-Op ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ocrPath)) ([Windows.Storage.StorageFile])
    $stream = Await-Op ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    try {
        $decoder = Await-Op ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
        $bitmap = Await-Op ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
        $ocr = Await-Op ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    } finally { $stream.Dispose() }
    $text = [string]$ocr.Text
    # Windows OCR inserts a space between every CJK glyph; drop those so the
    # text reads like the screen does.  Spaces around latin words stay.
    $text = [regex]::Replace($text, '(?<=[\u4e00-\u9fff\u3000-\u303f])[ \t]+(?=[\u4e00-\u9fff\u3000-\u303f])', '')
    $lines = 0
    foreach ($ln in $ocr.Lines) { $lines++ }
    if ($scaledTmp) { Remove-Item -LiteralPath $scaledTmp -Force -ErrorAction SilentlyContinue }
    [pscustomobject]@{ Path = $full; Chars = $text.Length; Lines = $lines; Text = $text }
}

# ---- moyu boundary: refuse everything when mode=moyu and boundaries.motion=false ----
# Second gate for the "motion" switch, independent of the plugin (still works if the plugin is edited).
$MoyuDir = Split-Path -Parent $ToolDir
$MoyuState = Join-Path $MoyuDir 'state.json'
if (Test-Path -LiteralPath $MoyuState) {
    try {
        $ms = [IO.File]::ReadAllText($MoyuState, [Text.UTF8Encoding]::new($false)) | ConvertFrom-Json
        if ($ms.mode -eq 'moyu' -and $ms.boundaries -and ($ms.boundaries.motion -eq $false)) {
            Refuse-Action ('action:' + $Action) 'moyu-boundary-motion-off'
        }
    } catch { }
}

# ---- mode gate (2026-11-01): this driver only works inside a moyu window ----
$StoreMode = ''
try {
    if (Test-Path -LiteralPath $MoyuState) {
        $store = [IO.File]::ReadAllText($MoyuState, [Text.UTF8Encoding]::new($false)) | ConvertFrom-Json
        $StoreMode = [string]$store.mode
    }
} catch { }
if ($StoreMode -ne 'moyu') {
    Write-Boundary ('action:' + $Action) ('not-in-moyu:' + $StoreMode) 'refused'
    Write-Act ('REFUSED action:' + $Action + ' :: not-in-moyu (mode=' + $StoreMode + ')')
    Write-Output 'refused: not-in-moyu (desktop control only works inside a moyu window)'
    exit 7
}
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class Desk {
    [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Explicit, Size = 40)] public struct INPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public MOUSEINPUT mi; [FieldOffset(8)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }

    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);

    public delegate bool EnumProc(IntPtr h, IntPtr l);

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    // lift to the top of the z-order without activating (keeps the user's caret where it was)
    public static bool Reveal(IntPtr h) {
        return SetWindowPos(h, (IntPtr)0, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010 | 0x0040);
    }
    [DllImport("user32.dll", SetLastError = true)] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint n, INPUT[] a, int size);
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

    const uint KUP = 2;
    const uint UNICODE = 4;

    public static void EnableDpi() {
        try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch { }
        try { SetProcessDPIAware(); } catch { }
    }

    public static List<IntPtr> windows = new List<IntPtr>();
    public static bool Collect(IntPtr h, IntPtr l) {
        if (IsWindowVisible(h)) {
            int n = GetWindowText(h, new StringBuilder(512), 512);
            if (n > 0) windows.Add(h);
        }
        return true;
    }
    public static IntPtr[] AllWindows() {
        windows = new List<IntPtr>();
        EnumWindows(new EnumProc(Collect), IntPtr.Zero);
        return windows.ToArray();
    }
    public static string TitleOf(IntPtr h) {
        var sb = new StringBuilder(512);
        GetWindowText(h, sb, 512);
        return sb.ToString();
    }
    public static int[] RectOf(IntPtr h) {
        RECT r; GetWindowRect(h, out r);
        return new int[] { r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top };
    }

    public static void AltTap() {
        INPUT d = new INPUT(); d.type = 1; d.ki.wVk = 0x12;
        INPUT u = new INPUT(); u.type = 1; u.ki.wVk = 0x12; u.ki.dwFlags = KUP;
        INPUT[] a = new INPUT[] { d, u };
        SendInput(2, a, Marshal.SizeOf(typeof(INPUT)));
    }

    public static bool Focus(IntPtr h) {
        if (h == IntPtr.Zero) return false;
        if (GetForegroundWindow() == h) return true;
        AltTap();
        ShowWindow(h, 9);
        BringWindowToTop(h);
        uint tid = GetCurrentThreadId();
        uint fg = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
        uint tt = GetWindowThreadProcessId(h, IntPtr.Zero);
        AttachThreadInput(tid, fg, true);
        AttachThreadInput(tid, tt, true);
        bool ok = SetForegroundWindow(h);
        AttachThreadInput(tid, tt, false);
        AttachThreadInput(tid, fg, false);
        return ok;
    }
    public static bool IsFg(IntPtr h) { return GetForegroundWindow() == h; }

    public static int TypeText(string s) {
        if (s == null || s.Length == 0) return 0;
        INPUT[] a = new INPUT[s.Length * 2];
        for (int i = 0; i < s.Length; i++) {
            a[i * 2].type = 1; a[i * 2].ki.wScan = (ushort)s[i]; a[i * 2].ki.dwFlags = UNICODE;
            a[i * 2 + 1].type = 1; a[i * 2 + 1].ki.wScan = (ushort)s[i]; a[i * 2 + 1].ki.dwFlags = UNICODE | KUP;
        }
        return (int)SendInput((uint)a.Length, a, Marshal.SizeOf(typeof(INPUT)));
    }

    public static int KeyChord(int[] mods, int vk) {
        List<INPUT> list = new List<INPUT>();
        for (int i = 0; i < mods.Length; i++) {
            INPUT d = new INPUT(); d.type = 1; d.ki.wVk = (ushort)mods[i];
            list.Add(d);
        }
        INPUT kd = new INPUT(); kd.type = 1; kd.ki.wVk = (ushort)vk; list.Add(kd);
        INPUT ku = new INPUT(); ku.type = 1; ku.ki.wVk = (ushort)vk; ku.ki.dwFlags = KUP; list.Add(ku);
        for (int i = mods.Length - 1; i >= 0; i--) {
            INPUT u = new INPUT(); u.type = 1; u.ki.wVk = (ushort)mods[i]; u.ki.dwFlags = KUP;
            list.Add(u);
        }
        INPUT[] a = list.ToArray();
        return (int)SendInput((uint)a.Length, a, Marshal.SizeOf(typeof(INPUT)));
    }

    public static int ClickAt(int x, int y, bool right, bool doubleClick) {
        SetCursorPos(x, y);
        uint down = right ? 8u : 2u;
        uint up = right ? 16u : 4u;
        List<INPUT> list = new List<INPUT>();
        int clicks = doubleClick ? 2 : 1;
        for (int i = 0; i < clicks; i++) {
            INPUT d = new INPUT(); d.type = 0; d.mi.dwFlags = down; list.Add(d);
            INPUT u = new INPUT(); u.type = 0; u.mi.dwFlags = up; list.Add(u);
        }
        INPUT[] a = list.ToArray();
        return (int)SendInput((uint)a.Length, a, Marshal.SizeOf(typeof(INPUT)));
    }

    public static int[] Cursor() {
        POINT p; GetCursorPos(out p);
        return new int[] { p.X, p.Y };
    }

    public static int Wheel(int delta, bool horizontal) {
        INPUT w = new INPUT(); w.type = 0;
        w.mi.dwFlags = horizontal ? 0x1000u : 0x0800u;
        w.mi.mouseData = unchecked((uint)delta);
        INPUT[] a = new INPUT[] { w };
        return (int)SendInput(1, a, Marshal.SizeOf(typeof(INPUT)));
    }

    public static int Button(bool right, bool down) {
        INPUT b = new INPUT(); b.type = 0;
        b.mi.dwFlags = right ? (down ? 8u : 16u) : (down ? 2u : 4u);
        INPUT[] a = new INPUT[] { b };
        return (int)SendInput(1, a, Marshal.SizeOf(typeof(INPUT)));
    }

    public static int DragRight(int x, int y, int dx, int dy, int steps) {
        if (steps < 1) steps = 1;
        SetCursorPos(x, y);
        Button(true, true);
        for (int i = 1; i <= steps; i++) {
            SetCursorPos(x + dx * i / steps, y + dy * i / steps);
            System.Threading.Thread.Sleep(8);
        }
        return Button(true, false);
    }
}
'@

[void][Desk]::EnableDpi()

function Resolve-Window {
    param([string]$pattern)
    if (-not $pattern) { throw 'this action needs -Title' }
    $hits = @()
    foreach ($h in [Desk]::AllWindows()) {
        $t = [Desk]::TitleOf($h)
        if ($t -and $t.ToLower().Contains($pattern.ToLower())) {
            $r = [Desk]::RectOf($h)
            $hits += [pscustomobject]@{ Handle = $h; Title = $t; Rect = $r }
        }
    }
    if ($hits.Count -eq 0) { throw "no window matched '$pattern'" }
    if ($hits.Count -gt 1) {
        # 2026-11-08: 标题是子串匹配，命中多个时绝不猜第一个——猜错就是把点击/打字
        # 送进另一个窗口（曾经靠 $hits[0] 蒙对过，那是运气，不是保证）。
        # 有且仅有一个标题与 pattern 完全相等才认；否则列出来让人改精确。
        $exact = @($hits | Where-Object { $_.Title.ToLower() -eq $pattern.ToLower() })
        if ($exact.Count -eq 1) { return $exact[0] }
        $names = ($hits | ForEach-Object { "'" + $_.Title + "'" }) -join ', '
        throw ("ambiguous -Title '$pattern': " + $hits.Count + " windows matched (" + $names + "); use a longer or exact title")
    }
    return $hits[0]
}

$result = $null
try {
    if ($Focus -and $Action.ToLower() -in @('type', 'key', 'clickwin', 'move', 'wheel', 'rdrag', 'rclick', 'mdown', 'mup')) {
        $fw = Resolve-Window $Focus
        Assert-Guard $fw.Handle ('focus:' + $Focus)
        if ($DryRun) { Write-Output ('would focus: ' + $fw.Title) }
        else {
            [void][Desk]::Focus($fw.Handle)
            Start-Sleep -Milliseconds 200
            if (-not [Desk]::IsFg($fw.Handle)) { throw ('focus failed: ' + $fw.Title) }
            $r = $fw.Rect
            [void][Desk]::ClickAt($r[0] + [int]($r[2] / 2), $r[1] + [int]($r[3] / 2), $false, $false)
            Start-Sleep -Milliseconds 150
        }
    }
    # injecting actions with no explicit target: judge the window we are about to hit
    # (actions that resolve their own -Title are guarded inside their case)
    $targeted = $Title -and $Action.ToLower() -in @('focus', 'clickwin', 'type', 'invoke')
    if (-not $Focus -and -not $targeted -and $Action.ToLower() -in @('focus', 'click', 'clickwin', 'invoke', 'type', 'key', 'rdrag', 'rclick', 'mdown', 'mup')) {
        $fgHandle = [Desk]::GetForegroundWindow()
        if ($Action.ToLower() -eq 'click' -and $X -ne [int]::MinValue -and $Y -ne [int]::MinValue) {
            $pt = New-Object Desk+POINT
            $pt.X = $X; $pt.Y = $Y
            $hit = [Desk]::WindowFromPoint($pt)
            if ($hit -ne [IntPtr]::Zero) { $fgHandle = $hit }
        }
        Assert-Guard $fgHandle ('action:' + $Action)
    }

    # throughput cap: counts successful injections, not refusals (2026-11-02)
    if (-not $DryRun -and $Action.ToLower() -in @('click', 'clickwin', 'invoke', 'move', 'wheel', 'rclick', 'rdrag', 'mdown', 'mup', 'type', 'key', 'focus')) {
        Test-ActionQuota ('action:' + $Action.ToLower())
    }

    # intent accounting (2026-11-02, item 7): one line BEFORE the injection, so a
    # misfire (focus stolen, wrong window) can be told apart from a plan.
    # never blocks; dry-run and read-only actions are skipped.
    if (-not $DryRun -and $Action.ToLower() -in @('click', 'clickwin', 'invoke', 'move', 'wheel', 'rclick', 'rdrag', 'mdown', 'mup', 'type', 'key', 'focus')) {
        $planWhat = 'plan:' + $Action.ToLower()
        if ($Title) { $planWhat = $planWhat + ' title=' + $Title }
        if ($X -ne [int]::MinValue -and $Y -ne [int]::MinValue) { $planWhat = $planWhat + ' at=' + $X + ',' + $Y }
        if ($RX -ne 0 -or $RY -ne 0) { $planWhat = $planWhat + ' rxy=' + $RX + ',' + $RY }
        if ($Action.ToLower() -eq 'type') { $planWhat = $planWhat + ' chars=' + ([string]$Text).Length }
        if ($Action.ToLower() -eq 'key') { $planWhat = $planWhat + ' keys=' + $Keys }
        Write-Boundary $planWhat 'about-to-act' 'planned' 0
    }

    switch ($Action.ToLower()) {
        'windows' {
            $rows = @()
            foreach ($h in [Desk]::AllWindows()) {
                $r = [Desk]::RectOf($h)
                $rows += [pscustomobject]@{ Hwnd = ('0x{0:X}' -f $h.ToInt64()); Title = [Desk]::TitleOf($h); X = $r[0]; Y = $r[1]; W = $r[2]; H = $r[3] }
            }
            $result = $rows
        }
        'rect' {
            $w = Resolve-Window $Title
            $result = [pscustomobject]@{ Title = $w.Title; X = $w.Rect[0]; Y = $w.Rect[1]; W = $w.Rect[2]; H = $w.Rect[3]; Handle = ('0x{0:X}' -f $w.Handle.ToInt64()) }
        }
        'focus' {
            $w = Resolve-Window $Title
            Assert-Guard $w.Handle ('focus:' + $Title)
            if ($DryRun) { $result = [pscustomobject]@{ DryRun = $true; Title = $w.Title } }
            else {
                [void][Desk]::Focus($w.Handle)
                Start-Sleep -Milliseconds 150
                $result = [pscustomobject]@{ Title = $w.Title; IsForeground = [Desk]::IsFg($w.Handle) }
            }
        }
        'reveal' {
            # like focus, but does not steal activation: the window comes to the
            # front of the z-order and the user keeps typing where they were.
            $w = Resolve-Window $Title
            Assert-Guard $w.Handle ('reveal:' + $Title)
            if ($DryRun) { $result = [pscustomobject]@{ DryRun = $true; Title = $w.Title } }
            else {
                $okr = [Desk]::Reveal($w.Handle)
                Start-Sleep -Milliseconds 120
                $result = [pscustomobject]@{ Title = $w.Title; Revealed = [bool]$okr; IsForeground = [Desk]::IsFg($w.Handle) }
            }
        }
        'seq' {
            # 一串动作一次跑完（2026-11-17 加）：游戏里「点塔→点格子→再点格子」必须连着发生，
            # 每次工具调用之间隔一两秒，游戏就当成三次独立点击了。这里在一次调用里按顺序做完。
            # 写法：click:960,600;sleep:280;click:960,600   也支持 move:x,y 和 key:esc
            if (-not $Seq) { throw 'seq needs -Seq, e.g. "click:960,600;sleep:280;click:960,600"' }
            if (-not $Title) { throw 'seq needs -Title（要点哪个窗口；不能盲点桌面）' }
            $w = Resolve-Window $Title
            Assert-Guard $w.Handle ('seq:' + $Title)
            if ($Focus) { $null = [Desk]::Reveal($w.Handle); Start-Sleep -Milliseconds 150 }
            $done = @()
            foreach ($item in $Seq.Split(';')) {
                $t = $item.Trim()
                if (-not $t) { continue }
                $i = $t.IndexOf(':')
                $verb = if ($i -gt 0) { $t.Substring(0, $i).Trim().ToLower() } else { $t.ToLower() }
                $arg = if ($i -gt 0) { $t.Substring($i + 1).Trim() } else { '' }
                switch ($verb) {
                    'click' {
                        $p = $arg.Split(',')
                        if ($p.Length -lt 2) { throw "click 要写成 x,y：$t" }
                        $cx = [int]$p[0]; $cy = [int]$p[1]
                        $wait = if ($p.Length -ge 3) { [int]$p[2] } else { 0 }
                        if (-not $DryRun) { $null = [Desk]::ClickAt($cx, $cy, $false, $false) }
                        $done += "click $cx,$cy"
                        if ($wait -gt 0) { Start-Sleep -Milliseconds $wait }
                    }
                    'move' {
                        $p = $arg.Split(',')
                        if ($p.Length -lt 2) { throw "move 要写成 x,y：$t" }
                        if (-not $DryRun) { [void][Desk]::SetCursorPos([int]$p[0], [int]$p[1]) }
                        $done += "move $arg"
                    }
                    'sleep' {
                        $ms = [int]$arg
                        if ($ms -gt 0) { Start-Sleep -Milliseconds $ms }
                        $done += "sleep $ms"
                    }
                    'key' {
                        $vkMap = @{ 'enter' = 0x0D; 'tab' = 0x09; 'esc' = 0x1B; 'space' = 0x20; 'up' = 0x26; 'down' = 0x28; 'left' = 0x25; 'right' = 0x27 }
                        $k = $arg.ToLower()
                        if (-not $vkMap.ContainsKey($k)) { throw "seq 里只支持少数按键：enter/tab/esc/space/up/down/left/right（要别的用 key 动作）" }
                        if (-not $DryRun) { $null = [Desk]::KeyChord(@(), $vkMap[$k]) }
                        $done += "key $k"
                    }
                    default { throw "seq 里不认识的动作：$verb（支持 click/move/sleep/key）" }
                }
            }
            $result = [pscustomobject]@{ Title = $w.Title; Steps = $done.Count; Done = ($done -join ' | ') }
        }
        'click' {
            if ($X -eq [int]::MinValue -or $Y -eq [int]::MinValue) { throw 'click needs -X and -Y' }
            if ($DryRun) { $result = [pscustomobject]@{ DryRun = $true; X = $X; Y = $Y } }
            else { $n = [Desk]::ClickAt($X, $Y, $false, $false); $result = [pscustomobject]@{ X = $X; Y = $Y; Events = $n } }
        }
        'clickwin' {
            $w = Resolve-Window $Title
            Assert-Guard $w.Handle ('clickwin:' + $Title)
            $px = $w.Rect[0] + $RX
            $py = $w.Rect[1] + $RY
            if ($DryRun) { $result = [pscustomobject]@{ DryRun = $true; Title = $w.Title; X = $px; Y = $py } }
            else { $n = [Desk]::ClickAt($px, $py, $false, $false); $result = [pscustomobject]@{ Title = $w.Title; X = $px; Y = $py; Events = $n } }
        }
        'invoke' {
            # distant click (2026-11-06): never moves the physical cursor, never
            # steals keyboard focus. UIA pattern first, window message as fallback.
            # shows the probe ring for ~0.9s so the owner can see where it lands.
            $w = Resolve-Window $Title
            Assert-Guard $w.Handle ('invoke:' + $Title)
            $px = $w.Rect[0] + $RX
            $py = $w.Rect[1] + $RY
            if ($DryRun) { $result = [pscustomobject]@{ DryRun = $true; Title = $w.Title; X = $px; Y = $py } }
            else {
                $ri = Join-Path $ToolDir 'remote-invoke.ps1'
                if (-not (Test-Path -LiteralPath $ri)) { throw 'remote-invoke.ps1 missing' }
                $raw = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ri -Hwnd $w.Handle.ToInt64() -X $px -Y $py 2>&1
                $o = $null
                try { $line = @($raw | Where-Object { $_ -match '^\{' })[-1]; $o = $line | ConvertFrom-Json } catch { }
                if ($o -and $o.ok) {
                    $result = [pscustomobject]@{ Title = $w.Title; X = $px; Y = $py; Method = $o.method; Element = $o.element; Ok = $true }
                } else {
                    $why = if ($o) { $o.why } else { ($raw -join ' ') }
                    throw ('invoke failed: ' + $why)
                }
            }
        }
        'move' {
            if ($X -eq [int]::MinValue) { throw 'move needs -X and -Y' }
            # read-only: judge the window under the destination point, not the foreground.
            # otherwise any shell we just ran (which holds foreground) blocks every move.
            $ptm = New-Object Desk+POINT
            $ptm.X = $X; $ptm.Y = $Y
            $hm = [Desk]::WindowFromPoint($ptm)
            if ($hm -ne [IntPtr]::Zero) { Assert-Guard $hm 'move:under' -ReadOnly }
            if ($DryRun) { $result = [pscustomobject]@{ DryRun = $true; X = $X; Y = $Y } }
            else { $ok = [Desk]::SetCursorPos($X, $Y); $result = [pscustomobject]@{ X = $X; Y = $Y; Ok = $ok } }
        }
        'wheel' {
            if ($Delta -eq 0) { $Delta = -120 }
            $ptw = New-Object Desk+POINT
            if ($X -ne [int]::MinValue -and $Y -ne [int]::MinValue) { $ptw.X = $X; $ptw.Y = $Y }
            else { [void][Desk]::GetCursorPos([ref]$ptw) }
            $hw = [Desk]::WindowFromPoint($ptw)
            if ($hw -ne [IntPtr]::Zero) { Assert-Guard $hw 'wheel:under' -ReadOnly }
            if ($DryRun) { $result = [pscustomobject]@{ DryRun = $true; Delta = $Delta; Horizontal = [bool]$Horizontal } }
            else {
                if ($X -ne [int]::MinValue -and $Y -ne [int]::MinValue) { [void][Desk]::SetCursorPos($X, $Y) }
                $n = [Desk]::Wheel($Delta, [bool]$Horizontal)
                $result = [pscustomobject]@{ Delta = $Delta; Events = $n; Horizontal = [bool]$Horizontal }
            }
        }
        'rclick' {
            if ($X -eq [int]::MinValue -or $Y -eq [int]::MinValue) { throw 'rclick needs -X and -Y' }
            if ($DryRun) { $result = [pscustomobject]@{ DryRun = $true; X = $X; Y = $Y } }
            else { $n = [Desk]::ClickAt($X, $Y, $true, $false); $result = [pscustomobject]@{ X = $X; Y = $Y; Events = $n } }
        }
        'rdrag' {
            if ($DX -eq 0 -and $DY -eq 0) { throw 'rdrag needs -DX and/or -DY' }
            $sx = if ($X -ne [int]::MinValue) { $X } else { 0 }
            $sy = if ($Y -ne [int]::MinValue) { $Y } else { 0 }
            if ($DryRun) { $result = [pscustomobject]@{ DryRun = $true; StartX = $sx; StartY = $sy; DX = $DX; DY = $DY; Steps = $Steps } }
            else {
                if ($X -eq [int]::MinValue) {
                    $cur = [Desk]::Cursor()
                    $sx = $cur[0]; $sy = $cur[1]
                }
                $n = 0
                try { $n = [Desk]::DragRight($sx, $sy, $DX, $DY, $Steps) }
                catch { try { [void][Desk]::Button($true, $false) } catch { }; throw }
                $result = [pscustomobject]@{ StartX = $sx; StartY = $sy; DX = $DX; DY = $DY; Steps = $Steps; Events = $n }
            }
        }
        'mdown' {
            if ($DryRun) { $result = [pscustomobject]@{ DryRun = $true; Button = if ($Right) { 'right' } else { 'left' } } }
            else { $n = [Desk]::Button([bool]$Right, $true); $result = [pscustomobject]@{ Button = if ($Right) { 'right' } else { 'left' }; Events = $n } }
        }
        'mup' {
            if ($DryRun) { $result = [pscustomobject]@{ DryRun = $true; Button = if ($Right) { 'right' } else { 'left' } } }
            else { $n = [Desk]::Button([bool]$Right, $false); $result = [pscustomobject]@{ Button = if ($Right) { 'right' } else { 'left' }; Events = $n } }
        }
        'type' {
            if (-not $Text) { throw 'type needs -Text' }
            if ($DryRun) { $result = [pscustomobject]@{ DryRun = $true; Length = $Text.Length; Text = $Text } }
            else {
                # focus can be stolen between the guard check and the injection
                # (a popup, a window switching itself forward) -- re-verify that
                # the intended window still owns the input, and refuse rather
                # than type into whatever is in front (2026-11-02)
                $intended = [IntPtr]::Zero
                $label = 'foreground'
                if ($Focus) { $intended = (Resolve-Window $Focus).Handle; $label = $Focus }
                elseif ($Title) { $intended = (Resolve-Window $Title).Handle; $label = $Title }
                else { $intended = [Desk]::GetForegroundWindow() }
                Assert-Guard $intended ('type:' + $label)
                if (-not [Desk]::IsFg($intended)) {
                    [void][Desk]::Focus($intended)
                    Start-Sleep -Milliseconds 200
                    if (-not [Desk]::IsFg($intended)) { Refuse-Action ('type:' + $label) 'type-target-not-foreground' }
                }
                $sw = [Diagnostics.Stopwatch]::StartNew()
                $n = 0
                if ($DelayMs -le 0) {
                    $n = [Desk]::TypeText($Text)
                } else {
                    foreach ($ch in $Text.ToCharArray()) {
                        $n += [Desk]::TypeText([string]$ch)
                        Start-Sleep -Milliseconds $DelayMs
                    }
                }
                $sw.Stop()
                $result = [pscustomobject]@{ Length = $Text.Length; Events = $n; ElapsedMs = $sw.ElapsedMilliseconds; DelayMs = $DelayMs }
            }
        }
        'key' {
            if (-not $Keys) { throw 'key needs -Keys, e.g. ctrl+s' }
            $vkMap = @{
                'ctrl' = 0x11; 'control' = 0x11; 'shift' = 0x10; 'alt' = 0x12; 'win' = 0x5B
                'enter' = 0x0D; 'return' = 0x0D; 'tab' = 0x09; 'esc' = 0x1B; 'escape' = 0x1B; 'space' = 0x20
                'backspace' = 0x08; 'del' = 0x2E; 'delete' = 0x2E; 'ins' = 0x2D; 'insert' = 0x2D
                'home' = 0x24; 'end' = 0x23; 'pgup' = 0x21; 'pgdn' = 0x22
                'left' = 0x25; 'up' = 0x26; 'right' = 0x27; 'down' = 0x28
                'caps' = 0x14; 'prtsc' = 0x2C; 'pause' = 0x13; 'menu' = 0x5D
            }
            for ($i = 1; $i -le 24; $i++) { $vkMap["f$i"] = 0x6F + $i }
            for ($c = 65; $c -le 90; $c++) { $vkMap[[string][char]$c] = $c }
            for ($d = 0; $d -le 9; $d++) { $vkMap["$d"] = 0x30 + $d }
            $parts = $Keys.ToLower().Split('+')
            $mods = @()
            for ($i = 0; $i -lt $parts.Length - 1; $i++) {
                $p = $parts[$i].Trim()
                if (-not $vkMap.ContainsKey($p)) { throw "unknown modifier '$p'" }
                $mods += $vkMap[$p]
            }
            $main = $parts[$parts.Length - 1].Trim()
            if (-not $vkMap.ContainsKey($main)) { throw "unknown key '$main'" }
            $vk = $vkMap[$main]
            if ($DryRun) { $result = [pscustomobject]@{ DryRun = $true; Mods = ($mods -join ','); Vk = ('0x{0:X2}' -f $vk) } }
            else { $n = [Desk]::KeyChord($mods, $vk); $result = [pscustomobject]@{ Keys = $Keys; Vk = ('0x{0:X2}' -f $vk); Events = $n } }
        }
        'shot' {
            Add-Type -AssemblyName System.Drawing
            Add-Type -AssemblyName System.Windows.Forms
            [void][Desk]::EnableDpi()
            $wx = 0; $wy = 0; $ww = 0; $wh = 0
            if ($Title) {
                $win = Resolve-Window $Title
                $wx = $win.Rect[0]; $wy = $win.Rect[1]; $ww = $win.Rect[2]; $wh = $win.Rect[3]
            } else {
                $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
                $wx = $b.X; $wy = $b.Y; $ww = $b.Width; $wh = $b.Height
            }
            $cw = $ww; $ch = $wh
            if ($RW -gt 0 -or $RH -gt 0) {
                if ($RW -gt 0) { $cw = $RW } else { $cw = $ww - $RX }
                if ($RH -gt 0) { $ch = $RH } else { $ch = $wh - $RY }
            }
            if ($RX -lt 0) { throw "RX must be >= 0" }
            if ($RY -lt 0) { throw "RY must be >= 0" }
            if (($RX + $cw) -gt $ww) { $cw = $ww - $RX }
            if (($RY + $ch) -gt $wh) { $ch = $wh - $RY }
            if ($cw -le 0 -or $ch -le 0) { throw "crop rect is empty (window $ww x $wh)" }
            $srcX = $wx + $RX; $srcY = $wy + $RY
            $shotId = if ($Title) { 'shot:' + $Title } else { 'shot:screen' }
            Assert-ShotClear $srcX $srcY $cw $ch $shotId
            $bmp = New-Object System.Drawing.Bitmap $cw, $ch
            $g = [System.Drawing.Graphics]::FromImage($bmp)
            $g.CopyFromScreen($srcX, $srcY, 0, 0, $bmp.Size)
            $g.Dispose()
            $outBmp = $bmp
            if ($Zoom -gt 1) {
                $nw = $cw * $Zoom; $nh = $ch * $Zoom
                $zb = New-Object System.Drawing.Bitmap $nw, $nh
                $zg = [System.Drawing.Graphics]::FromImage($zb)
                $zg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
                $zg.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
                $zg.DrawImage($bmp, 0, 0, $nw, $nh)
                $zg.Dispose()
                $outBmp = $zb
            } elseif (-not $Ocr) {
                $longEdge = [Math]::Max($cw, $ch)
                if ($longEdge -gt $MaxEdge) {
                    $scale = $MaxEdge / [double]$longEdge
                    $nw = [int][Math]::Round($cw * $scale); $nh = [int][Math]::Round($ch * $scale)
                    $sb = New-Object System.Drawing.Bitmap $nw, $nh
                    $sg = [System.Drawing.Graphics]::FromImage($sb)
                    $sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
                    $sg.DrawImage($bmp, 0, 0, $nw, $nh)
                    $sg.Dispose()
                    $outBmp = $sb
                }
            }
            if (-not $Out) {
                $shotDir = Join-Path $PlaygroundDir 'shots'
                if (-not (Test-Path -LiteralPath $shotDir)) { [void](New-Item -ItemType Directory -Path $shotDir -Force) }
                $Out = Join-Path $shotDir ('shot-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + $(if ($Jpeg) { '.jpg' } else { '.png' }))
            } else {
                $outParent = Split-Path -Parent $Out
                if ($outParent -and -not (Test-Path -LiteralPath $outParent)) { [void](New-Item -ItemType Directory -Path $outParent -Force) }
            }
            if ($DryRun) {
                $result = [pscustomobject]@{ DryRun = $true; SrcX = $srcX; SrcY = $srcY; SrcW = $cw; SrcH = $ch; W = $outBmp.Width; H = $outBmp.Height; Zoom = $Zoom }
            } else {
                $fmtExt = [IO.Path]::GetExtension($Out).ToLower()
                $useJpeg = $Jpeg -or ($fmtExt -eq '.jpg') -or ($fmtExt -eq '.jpeg')
                if ($useJpeg) {
                    $enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
                    $ep = New-Object System.Drawing.Imaging.EncoderParameters 1
                    $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality, [long]85)
                    $outBmp.Save($Out, $enc, $ep)
                } else {
                    $outBmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
                }
                $result = [pscustomobject]@{ Out = $Out; SrcX = $srcX; SrcY = $srcY; SrcW = $cw; SrcH = $ch; W = $outBmp.Width; H = $outBmp.Height; Zoom = $Zoom; Bytes = (Get-Item $Out).Length }
                $inPlayground = $Out.StartsWith($PlaygroundDir, [StringComparison]::OrdinalIgnoreCase)
                Write-Boundary $shotId ('captured:' + $Out + $(if ($inPlayground) { '' } else { ' (outside playground)' })) 'ok' 0
                if ($Ocr) {
                    $ocrRes = Invoke-Ocr -ImagePath $Out
                    $txtPath = [IO.Path]::ChangeExtension($Out, '.txt')
                    [IO.File]::WriteAllText($txtPath, [string]$ocrRes.Text, [Text.UTF8Encoding]::new($false))
                    $result | Add-Member -NotePropertyName OcrChars -NotePropertyValue $ocrRes.Chars
                    $result | Add-Member -NotePropertyName OcrTxt -NotePropertyValue $txtPath
                    $result | Add-Member -NotePropertyName OcrText -NotePropertyValue $ocrRes.Text
                    Write-Boundary ('ocr:' + $Out) ('chars=' + $ocrRes.Chars) 'ok' 0
                }
            }
            if (-not [object]::ReferenceEquals($outBmp, $bmp)) { $outBmp.Dispose() }
            $bmp.Dispose()
        }
        'ocr' {
            $res = Invoke-Ocr -ImagePath $Path
            if (-not $DryRun) { Write-Boundary ('ocr:' + $res.Path) ('chars=' + $res.Chars) 'ok' 0 }
            $result = $res
        }
        default { throw "unknown action '$Action'" }
    }
    # ---- success accounting (2026-11-02): every injected action leaves a line --
    # result=ok lines are layer=0 and never count toward the rate limit
    # (Test-RateLimited only looks at result=refused).  shot writes its own line
    # with the output path, so it is excluded here.
    if (-not $DryRun -and $result -and $Action.ToLower() -in @('click', 'clickwin', 'move', 'wheel', 'rclick', 'rdrag', 'mdown', 'mup', 'type', 'key', 'focus')) {
        $okWhat = 'action:' + $Action.ToLower()
        if ($Title) { $okWhat = $okWhat + ' title=' + $Title }
        Write-Boundary $okWhat 'injected' 'ok' 0
    }
} catch {
    # never leave a button held down (2026-11-02): a stuck left button drags the
    # desktop around until someone clicks.  Best-effort release, then report.
    try { [void][Desk]::Button($false, $false); [void][Desk]::Button($true, $false) } catch { }
    Write-Act ("ERROR {0} :: {1}" -f $Action, $_.Exception.Message)
    Write-Output ("error: " + $_.Exception.Message)
    exit 1
}

[void][Desk]::EnableDpi()
Write-Act ("{0} {1}{2}" -f $Action, ($result | ConvertTo-Json -Compress), $(if ($DryRun) { ' (dry-run)' } else { '' }))
$result | Format-List

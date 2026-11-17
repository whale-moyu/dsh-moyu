param(
  [string]$User = 'akweb',
  [string]$SecretFile = "$env:USERPROFILE\.dsh\moyu\secrets\web-account.json",
  [switch]$StatusOnly
)

# 2026-11-17：给 akweb 建出 NTUSER.DAT，并在它自己的 hive 里写 Edge 策略（file:// 禁导航）。
# 只影响 akweb 账号；Administrator（用户）自己的 Edge 不受影响。
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class Prof {
  [StructLayout(LayoutKind.Sequential)]
  public struct PROFILEINFO {
    public int dwSize;
    public int dwFlags;
    [MarshalAs(UnmanagedType.LPWStr)] public string lpUserName;
    [MarshalAs(UnmanagedType.LPWStr)] public string lpProfilePath;
    [MarshalAs(UnmanagedType.LPWStr)] public string lpDefaultPath;
    [MarshalAs(UnmanagedType.LPWStr)] public string lpServerName;
    [MarshalAs(UnmanagedType.LPWStr)] public string lpPolicyPath;
    public IntPtr hProfile;
  }

  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool LogonUser(string user, string domain, string password, int type, int provider, out SafeAccessTokenHandle token);

  [DllImport("userenv.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool LoadUserProfile(SafeAccessTokenHandle token, ref PROFILEINFO pi);

  [DllImport("userenv.dll", SetLastError = true)]
  public static extern bool UnloadUserProfile(SafeAccessTokenHandle token, IntPtr hProfile);
}
'@

$hive = "C:\Users\$User\NTUSER.DAT"

if ($StatusOnly) {
  "NTUSER.DAT: " + (Test-Path $hive)
  $sid = (Get-LocalUser -Name $User -ErrorAction SilentlyContinue).SID.Value
  if ($sid) { "SID: $sid" }
  return
}

$sec = [System.IO.File]::ReadAllText($SecretFile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
$pass = $sec.password

$token = $null
if (-not [Prof]::LogonUser($User, '.', $pass, 2, 0, [ref]$token)) {
  throw ("LogonUser 失败: " + [Runtime.InteropServices.Marshal]::GetLastWin32Error())
}
$sid = (Get-LocalUser -Name $User).SID.Value
"logged on as $User (SID $sid)"

$pi = New-Object Prof+PROFILEINFO
$pi.dwSize = [Runtime.InteropServices.Marshal]::SizeOf($pi)
$pi.lpUserName = $User
$pi.dwFlags = 1
if (-not [Prof]::LoadUserProfile($token, [ref]$pi)) {
  throw ("LoadUserProfile 失败: " + [Runtime.InteropServices.Marshal]::GetLastWin32Error())
}

# 写策略到 akweb 自己的 hive（HKU\<SID>）
$key = "Registry::HKEY_USERS\$sid\Software\Policies\Microsoft\Edge"
New-Item -Path $key -Force | Out-Null
New-ItemProperty -Path $key -Name 'FileUrlNavigationEnabled' -Value 0 -PropertyType DWord -Force | Out-Null
$check = (Get-ItemProperty -Path $key -Name 'FileUrlNavigationEnabled').FileUrlNavigationEnabled
"policy written: FileUrlNavigationEnabled=$check"

[void][Prof]::UnloadUserProfile($token, $pi.hProfile)
$token.Dispose()
"profile unloaded"

Start-Sleep -Seconds 2
"NTUSER.DAT now: " + (Test-Path $hive)

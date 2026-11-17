' Launch the moyu watchman with no console window.
'
' Why a VBS: Start-Process node.exe keeps guard as a child of DSH, so closing
' DSH takes the watchman down with it (that defeats the whole point of an
' outer watchman). schtasks /run detaches properly but may flash a console box.
'
' 2026-10-30: launch node.exe directly instead of firing guard.cmd through
' WScript.Shell.Run -- a .cmd is started via cmd.exe /c and the intermediate
' console can still appear. One less process, no console host at all.
'
' node resolution order (so the same zip works on someone else's machine):
'   1. node-path.txt next to this script (written by install.ps1 / doctor.ps1)
'   2. %DSH_NODE%
'   3. node.exe on PATH
'   4. %USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe
'
' Exits quietly with code 1 if no node is found. guard.log stays silent in
' that case -- run doctor.cmd for a readable diagnosis.

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)

Function FirstLine(path)
  Dim ts, s
  FirstLine = ""
  If Not fso.FileExists(path) Then Exit Function
  On Error Resume Next
  Set ts = fso.OpenTextFile(path, 1)
  If Err.Number = 0 Then
    s = Trim(ts.ReadLine())
    ts.Close
    FirstLine = s
  End If
  On Error GoTo 0
End Function

node = FirstLine(dir & "\node-path.txt")

If node = "" Then
  env = sh.ExpandEnvironmentStrings("%DSH_NODE%")
  If env <> "%DSH_NODE%" Then node = env
End If

If node = "" Then
  On Error Resume Next
  Set exec = sh.Exec("cmd /c where node.exe")
  If Err.Number = 0 Then
    out = Trim(exec.StdOut.ReadAll())
    If out <> "" Then node = Split(out, vbCrLf)(0)
  End If
  On Error GoTo 0
End If

If node = "" Then
  cand = sh.ExpandEnvironmentStrings("%USERPROFILE%") & "\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
  If fso.FileExists(cand) Then node = cand
End If

If node = "" Then WScript.Quit 1
If Not fso.FileExists(node) Then WScript.Quit 1

guard = dir & "\guard.mjs"
If Not fso.FileExists(guard) Then WScript.Quit 1

sh.Run """" & node & """ """ & guard & """", 0, False

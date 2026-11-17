@echo off
rem Start proxy detached (start /b) with output to a log file.
rem 2026-11-17: bin\node.exe may be absent (install-l3 grants access in place now).
rem Look up node in this order: bin\node.exe -> l3-programs.json .node -> PATH.
set "NODE=%~dp0bin\node.exe"
if not exist "%NODE%" (
  for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "try { (Get-Content '%~dp0l3-programs.json' -Raw | ConvertFrom-Json).node } catch {}"`) do set "NODE=%%i"
)
if not exist "%NODE%" set "NODE=node"
start "akproxy" /b "%NODE%" "%~dp0web-proxy.mjs" >> "%~dp0freetime\web-proxy.log" 2>&1
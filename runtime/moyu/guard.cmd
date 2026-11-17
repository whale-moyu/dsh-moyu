@echo off
setlocal
if not defined DSH_HOME set "DSH_HOME=%USERPROFILE%\.dsh"
set "NODE="
if exist "%~dp0node-path.txt" set /p NODE=<"%~dp0node-path.txt"
if not defined NODE if defined DSH_NODE set "NODE=%DSH_NODE%"
if not defined NODE for %%i in (node.exe) do set "NODE=%%~$PATH:i"
if not defined NODE set "NODE=%DSH_HOME%\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE%" (
  echo [moyu] node not found. Set DSH_NODE or run doctor.cmd 1>&2
  exit /b 1
)
"%NODE%" "%~dp0guard.mjs" %*

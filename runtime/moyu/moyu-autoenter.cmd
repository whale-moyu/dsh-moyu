@echo off
rem Moyu-AutoEnter 的包装：计划任务不能直接跑「node.exe 参数」两段，
rem hidden-run.exe 只吃一个参数，之前写成未加引号的两段 → 每分钟起一个
rem 没有脚本参数的 node，永远挂着不退（2026-11-17 查出 1049 个，吃光提交内存）。
setlocal
set NODE=C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe
set GATE=C:\Users\Administrator\.dsh\moyu\gate.mjs
set LOG=C:\Users\Administrator\.dsh\moyu\logs\autoenter.log
"%NODE%" "%GATE%" >> "%LOG%" 2>&1
exit /b %ERRORLEVEL%

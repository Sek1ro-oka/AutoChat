@echo off
:: AutoChat one-click launcher. The real logic lives in scripts\stack-control.mjs
:: (start / stop / restart / status); this file is only the double-click entry.
::
:: What it starts, all hidden, no window per service:
::   1) SnowLuma  (dir from config.json snowluma.homeDir) -> OneBot 3000/3001
::   2) DSH web   (profile web, through scripts\dsh-web-supervisor.mjs) -> 3080
::   3) Bridge    (this repo, start.bat guard loop)        -> 3100
::
:: Why there is no schtasks call any more: the five periodic AutoChat tasks were
:: disabled on 2026-11-15 (they ran node.exe under InteractiveToken and popped a
:: visible Windows Terminal window every 2-5 minutes). A disabled task cannot be
:: started with "schtasks /Run" either - it fails with
::   ERROR: The scheduled task "..." could not run because it is disabled.
:: so the old "nudge the watchdog, wait 60s, then start directly" dance just
:: wasted two minutes. Start the services directly instead.
::
:: Two rules this file keeps:
::   * ASCII only - cmd decodes a .cmd with the console codepage, and UTF-8 Chinese
::     inside one breaks parsing.
::   * no absolute drive letters - the repo can be cloned anywhere, and the SnowLuma
::     install dir is read from config.json (snowluma.homeDir) inside the .mjs.
::
:: Logs: logs\launcher.log, logs\snowluma.out, logs\bridge.out, logs\dsh-web*.log
setlocal
chcp 65001 >nul
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
cd /d "%ROOT%"
if not exist "%ROOT%\logs" mkdir "%ROOT%\logs"

where node >nul 2>&1
if errorlevel 1 goto no_node

node "%ROOT%\scripts\stack-control.mjs" start
if errorlevel 1 goto failed

echo.
echo All three services are up. This window can be closed.
ping -n 5 127.0.0.1 >nul
exit /b 0

:failed
echo.
echo Something did not come up - see logs\launcher.log and logs\*.out
pause
exit /b 1

:no_node
echo node.exe was not found in PATH - install Node.js first.
pause
exit /b 1

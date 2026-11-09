@echo off
:: AutoChat one-click launcher. Starts three services:
::   1) SnowLuma  (dir from config.json snowluma.homeDir)  minimized -> OneBot 3000/3001, WebUI 5099
::   2) DSH web   (profile web, via supervisor)            hidden    -> 3080
::   3) Bridge    (this repo)                              minimized -> 3100
:: Logs: <repo>\logs\ (launcher.log, dsh-web.out, dsh-web-supervisor.log, bridge.out)
::
:: Two rules this file keeps:
::   * ASCII only -- cmd decodes a .cmd with the console codepage, and UTF-8 Chinese
::     inside one breaks parsing (it would also show up as mojibake in launcher.log).
::   * no absolute drive letters -- the repo can be cloned anywhere, and the SnowLuma
::     install dir is read from config.json (snowluma.homeDir) via
::     scripts\print-config.mjs. Hardcoded paths also fail scripts\privacy-scan.mjs.
setlocal
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
cd /d "%ROOT%"
if not exist "%ROOT%\logs" mkdir "%ROOT%\logs"
set "LAUNCHER_LOG=%ROOT%\logs\launcher.log"
echo [%DATE% %TIME%] launcher start >> "%LAUNCHER_LOG%" 2>&1

:: Preflight note: the DSH profile sometimes loses the bridge-managed MCP block
:: in cordis.patch.yml (the entries get moved into the "disabled shadow entries"
:: section, so the QQ agent ends up with zero MCP tools and every call fails with
:: "unknown tool"). Repairing it here with findstr is unreliable (the shadow
:: entries keep the same ids), so the check lives in scripts\dsh-web-supervisor.mjs:
:: it verifies the BEGIN/END block every 60s, rewrites it via setup-dsh.mjs and
:: restarts DSH when it is empty.

:: 1) SnowLuma -- the watchdog task ("AutoChat SnowLuma supervisor") owns the
::    lifecycle now: it probes 127.0.0.1:3001 and restarts the gateway through
::    launcher.bat. So nudge the task first and wait for the port. Starting
::    launcher.bat here while the watchdog does the same is exactly how you end up
::    with two gateways hooking one QQ (the duplicate falls back to WebUI 5101, and
::    two hooks racing on one QQ pipe made send_group_msg hang for 15s). The direct
::    start below stays as the fallback for installs without the task.
set "SNOWLUMA_DIR="
for /f "usebackq delims=" %%i in (`node "%ROOT%\scripts\print-config.mjs" snowluma.homeDir 2^>nul`) do set "SNOWLUMA_DIR=%%i"

netstat -ano | findstr /r /c:"127.0.0.1:3001 .*LISTENING" >nul 2>&1
if not errorlevel 1 goto snowluma_running
if not defined SNOWLUMA_DIR goto snowluma_nodir
schtasks /Query /TN "AutoChat SnowLuma supervisor" >nul 2>&1
if errorlevel 1 goto snowluma_direct
echo [%DATE% %TIME%] asking watchdog task to bring SnowLuma up >> "%LAUNCHER_LOG%" 2>&1
schtasks /Run /TN "AutoChat SnowLuma supervisor" >nul 2>&1
for /l %%n in (1,1,30) do (
  ping -n 3 127.0.0.1 >nul
  netstat -ano | findstr /r /c:"127.0.0.1:3001 .*LISTENING" >nul 2>&1
  if not errorlevel 1 goto snowluma_running
)
echo [%DATE% %TIME%] watchdog did not open 3001 in 60s - starting launcher.bat directly >> "%LAUNCHER_LOG%" 2>&1
:snowluma_direct
if not defined SNOWLUMA_DIR goto snowluma_nodir
echo [%DATE% %TIME%] starting SnowLuma (%SNOWLUMA_DIR%) >> "%LAUNCHER_LOG%" 2>&1
start "SnowLuma" /min /d "%SNOWLUMA_DIR%" cmd /c launcher.bat
goto snowluma_done
:snowluma_running
echo [%DATE% %TIME%] SnowLuma already listening on 3001 - skip >> "%LAUNCHER_LOG%" 2>&1
goto snowluma_done
:snowluma_nodir
echo [%DATE% %TIME%] SnowLuma NOT started: config.json snowluma.homeDir missing or empty >> "%LAUNCHER_LOG%" 2>&1
:snowluma_done

:: 2) DSH web via its supervisor: no window, restarts DSH if it dies. Starting it
::    twice is harmless (pid lock).
echo [%DATE% %TIME%] starting DSH supervisor >> "%LAUNCHER_LOG%" 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "Start-Process -FilePath 'node' -ArgumentList '%ROOT%\scripts\dsh-web-supervisor.mjs' -WindowStyle Hidden"

:: Wait for DSH (ping instead of timeout: timeout aborts when stdin is redirected)
ping -n 13 127.0.0.1 >nul

:: 3) Bridge -- the watchdog task ("AutoChat Bridge supervisor") owns the lifecycle
::    now: it probes 127.0.0.1:3100 and restarts the bridge through start.bat, and
::    start.bat itself keeps the :loop for plain node crashes. So nudge the task
::    first and wait for the port; the direct start stays as the fallback for
::    installs without the task (and the bridge refuses to run twice anyway: exit 2).
netstat -ano | findstr /r /c:"127.0.0.1:3100 .*LISTENING" >nul 2>&1
if not errorlevel 1 goto bridge_running
schtasks /Query /TN "AutoChat Bridge supervisor" >nul 2>&1
if errorlevel 1 goto bridge_direct
echo [%DATE% %TIME%] asking watchdog task to bring Bridge up >> "%LAUNCHER_LOG%" 2>&1
schtasks /Run /TN "AutoChat Bridge supervisor" >nul 2>&1
for /l %%n in (1,1,30) do (
  ping -n 3 127.0.0.1 >nul
  netstat -ano | findstr /r /c:"127.0.0.1:3100 .*LISTENING" >nul 2>&1
  if not errorlevel 1 goto bridge_running
)
echo [%DATE% %TIME%] watchdog did not open 3100 in 60s - starting start.bat directly >> "%LAUNCHER_LOG%" 2>&1
:bridge_direct
echo [%DATE% %TIME%] starting Bridge >> "%LAUNCHER_LOG%" 2>&1
start "Bridge" /min /d "%ROOT%" cmd /c "start.bat >> logs\bridge.out 2>&1"
goto bridge_done
:bridge_running
echo [%DATE% %TIME%] Bridge already listening on 3100 - skip >> "%LAUNCHER_LOG%" 2>&1
:bridge_done

echo [%DATE% %TIME%] launcher done >> "%LAUNCHER_LOG%" 2>&1
endlocal

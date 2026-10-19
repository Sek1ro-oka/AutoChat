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

:: 1) SnowLuma -- only if OneBot 3001 is not already listening. A second instance
::    would hook the same QQ process twice (the second one falls back to WebUI 5101),
::    and two hooks racing on one QQ pipe is what made send_group_msg hang forever
::    (bridge then reports "QQ send failed: 15000ms timeout").
set "SNOWLUMA_DIR="
for /f "usebackq delims=" %%i in (`node "%ROOT%\scripts\print-config.mjs" snowluma.homeDir 2^>nul`) do set "SNOWLUMA_DIR=%%i"

netstat -ano | findstr /r /c:"127.0.0.1:3001 .*LISTENING" >nul 2>&1
if not errorlevel 1 goto snowluma_running
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

:: 3) Bridge -- same guard: the bridge refuses to start twice anyway (exit 2),
::    but skipping keeps the log clean.
netstat -ano | findstr /r /c:"127.0.0.1:3100 .*LISTENING" >nul 2>&1
if not errorlevel 1 goto bridge_running
echo [%DATE% %TIME%] starting Bridge >> "%LAUNCHER_LOG%" 2>&1
start "Bridge" /min /d "%ROOT%" cmd /c "start.bat >> logs\bridge.out 2>&1"
goto bridge_done
:bridge_running
echo [%DATE% %TIME%] Bridge already listening on 3100 - skip >> "%LAUNCHER_LOG%" 2>&1
:bridge_done

echo [%DATE% %TIME%] launcher done >> "%LAUNCHER_LOG%" 2>&1
endlocal

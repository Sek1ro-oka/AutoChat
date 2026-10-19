@echo off
:: Switch bridge mode. DSH 0.2.0 never hot-applies qq-mode, so this edits the
:: profile config and restarts DSH web; otherwise the console switch gets
:: reverted on the next poll. ASCII only on purpose: cmd decodes this file with
:: the console codepage, and UTF-8 Chinese in a .cmd breaks parsing.
setlocal
set "MODE=%~1"
if not "%MODE%"=="" goto run
:menu
echo   1^) chat          normal chat
echo   2^) reserved2     second-gen simulation
echo   3^) reserved      first-gen simulation
echo   4^) closed-agent
set /p "MODE=Choose 1-4 or type a mode name: "
if "%MODE%"=="1" set "MODE=chat"
if "%MODE%"=="2" set "MODE=reserved2"
if "%MODE%"=="3" set "MODE=reserved"
if "%MODE%"=="4" set "MODE=closed-agent"
:run
node "%~dp0scripts\switch-mode.mjs" "%MODE%"
echo.
pause

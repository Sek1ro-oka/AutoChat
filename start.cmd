@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-all.ps1" -OpenQr
if errorlevel 1 echo Startup failed. Check the error above.
pause

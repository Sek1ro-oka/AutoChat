@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem 一键重启：SnowLuma + 桥接全停再起（DSH web 不动，它有自己的登录守护任务）。
rem 具体动作在 scripts\stack-control.mjs restart 里：
rem   ① 先杀 cmd /c start.bat 守护窗口，再按 state\bridge.lock 的 PID + 命令行含
rem      bridge.js（排除 mcp-* / node_modules）杀桥接，等 3100 真的释放再删锁；
rem   ② 杀 node index.mjs 和它的 launcher.bat 窗口，等 3001 释放；
rem   ③ 隐藏启动（无窗口，输出照旧写 logs\snowluma.out / logs\bridge.out）；
rem   ④ 最后查 OneBot get_login_info，确认 QQ 真的在线，而不是只看端口开着。
rem 旧版本只重启桥接、完全没碰 SnowLuma —— 2026-11-15 的「QQ 机器人未连接」正是
rem SnowLuma 没在运行（3001/3000 无监听），光重启桥接只会继续 code=1006 空转。
node "%~dp0scripts\stack-control.mjs" restart
if errorlevel 1 (
    echo.
    echo 重启失败，日志：logs\launcher.log / logs\snowluma.out / logs\bridge.out
    pause
    exit /b 1
)
echo.
echo 重启完成。
ping -n 6 127.0.0.1 >nul
exit /b 0

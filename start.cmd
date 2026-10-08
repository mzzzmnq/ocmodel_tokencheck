@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [tokencheck] 未找到 Node.js，请先安装 Node 22.5 或更高版本。
  pause
  exit /b 1
)
echo [tokencheck] 启动中... 浏览器将自动打开 http://127.0.0.1:7788/
start "" http://127.0.0.1:7788/
node --experimental-sqlite src\server.mjs
pause

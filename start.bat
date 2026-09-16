@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist node_modules (
  echo 首次运行，正在安装依赖，请稍候...
  call npm install
)
echo.
echo 正在启动合同审查工作台： http://localhost:8787
echo 按 Ctrl+C 可停止服务。
echo.
node server.js
pause

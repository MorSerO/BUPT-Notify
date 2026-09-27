@echo off
chcp 65001 >nul
title BUPT-Notify 安装（含开机自启）

rem ===========================================================================
rem  BUPT-Notify 一键安装 + 开机自启
rem
rem  与「install.cmd」相同，额外注册开机自启计划任务。
rem ===========================================================================

setlocal
cd /d "%~dp0"

echo.
echo   BUPT-Notify 一键安装（含开机自启）
echo   ============================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   没有检测到 Node.js。
  echo.
  echo   请先安装 Node.js 20 或更高版本（推荐 LTS）：
  echo       https://nodejs.org/zh-cn/download
  echo.
  set /p OPEN="   现在打开下载页面吗? (Y/n) "
  if /i not "%OPEN%"=="n" start "" "https://nodejs.org/zh-cn/download"
  echo.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-deps.ps1" -EnableAutostart
if errorlevel 1 (
  echo.
  echo   安装过程中出现问题，请查看上面的提示。
  echo.
  pause
  exit /b 1
)

echo.
echo   正在启动 BUPT-Notify ...
start "" wscript.exe "%~dp0start-bupt-notify.vbs"

echo.
echo   完成。以后开机会自动启动，桌面图标也可以随时手动打开。
echo.
pause
endlocal

@echo off
chcp 65001 >nul
title BUPT-Notify 安装

rem ===========================================================================
rem  BUPT-Notify 一键安装
rem
rem  使用方式：把整个文件夹下载下来，双击本文件即可。
rem  会自动检查 Node.js、安装依赖、创建桌面快捷方式，然后启动。
rem
rem  想同时启用开机自启，请双击「install-with-autostart.cmd」
rem ===========================================================================

setlocal
cd /d "%~dp0"

echo.
echo   BUPT-Notify 一键安装
echo   ============================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   没有检测到 Node.js。
  echo.
  echo   请先安装 Node.js 20 或更高版本（推荐 LTS）：
  echo       https://nodejs.org/zh-cn/download
  echo.
  echo   安装时请勾选 "Add to PATH"，装完后重新运行本文件。
  echo.
  set /p OPEN="   现在打开下载页面吗? (Y/n) "
  if /i not "%OPEN%"=="n" start "" "https://nodejs.org/zh-cn/download"
  echo.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-deps.ps1" %*
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
echo   完成。以后直接双击桌面上的「BUPT-Notify」图标即可。
echo.
pause
endlocal

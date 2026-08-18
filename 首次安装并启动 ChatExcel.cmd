@echo off
setlocal EnableExtensions
title ChatExcel Project Launcher

set "CHATEXCEL_FIRST_INSTALL_SCRIPT=%~dp0scripts\first-install.ps1"
if not exist "%CHATEXCEL_FIRST_INSTALL_SCRIPT%" (
  echo ChatExcel first-install script is missing:
  echo "%CHATEXCEL_FIRST_INSTALL_SCRIPT%"
  pause
  exit /b 1
)

"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%CHATEXCEL_FIRST_INSTALL_SCRIPT%" -Action Menu
set "CHATEXCEL_FIRST_INSTALL_EXIT_CODE=%ERRORLEVEL%"

if not "%CHATEXCEL_FIRST_INSTALL_EXIT_CODE%"=="0" (
  echo.
  echo ChatExcel launcher failed. See the message above.
  pause
)

exit /b %CHATEXCEL_FIRST_INSTALL_EXIT_CODE%

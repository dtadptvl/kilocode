@echo off
setlocal EnableExtensions
cd /d "%~dp0"
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set "RC=%ERRORLEVEL%"
if not defined ZERO_MEM_NO_PAUSE pause
exit /b %RC%

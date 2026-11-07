@echo off
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0"
title EveryAgent Windows Installer

if not exist "%~dp0install.ps1" (
    echo [ERROR] install.ps1 not found. Run this file from the release root.
    pause
    exit /b 1
)

rem Installing system dependencies requires administrator privileges.
net session >nul 2>&1
if errorlevel 1 (
    echo Requesting administrator privileges, please click "Yes" in the UAC prompt...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -WorkingDirectory '%~dp0' -Verb RunAs -ArgumentList '%*'"
    exit /b 0
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set "EA_EXIT=%ERRORLEVEL%"

echo.
if "%EA_EXIT%"=="0" (
    echo Installation finished. Run start-everyagent.bat to start the platform.
) else (
    echo Installation failed with exit code %EA_EXIT%. See the output above.
)
pause
exit /b %EA_EXIT%

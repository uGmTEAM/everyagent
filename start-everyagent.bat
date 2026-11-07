@echo off
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0"
title EveryAgent

if not exist "%~dp0tools\start-everyagent.ps1" (
    echo [ERROR] tools\start-everyagent.ps1 not found. Run this file from the release root.
    pause
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\start-everyagent.ps1" %*
set "EA_EXIT=%ERRORLEVEL%"

if not "%EA_EXIT%"=="0" (
    echo.
    echo Failed to start, exit code %EA_EXIT%. Check data\logs\launcher.log and data\logs\backend.err.log.
    pause
)
exit /b %EA_EXIT%

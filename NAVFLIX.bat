@echo off
title NAVFLIX
cd /d "%~dp0"

rem A Node carried in the app folder wins, so a portable drive runs on a machine
rem with nothing installed. Otherwise fall back to whatever is on PATH.
set "NODE=%~dp0runtime\node\node.exe"
if exist "%NODE%" goto run

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js was not found on this PC, and no copy is bundled here.
  echo.
  echo   Either install it from https://nodejs.org, or put node.exe at:
  echo     %~dp0runtime\node\node.exe
  echo.
  pause
  exit /b 1
)
set "NODE=node"

:run
"%NODE%" server.js
echo.
echo NAVFLIX has stopped.
pause

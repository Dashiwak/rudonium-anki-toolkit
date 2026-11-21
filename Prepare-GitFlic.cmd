@echo off
setlocal EnableExtensions DisableDelayedExpansion
where node.exe >nul 2>&1
if errorlevel 1 (
  echo Install Node.js 22.18 or later with npm, then run this file again.
  pause
  exit /b 1
)
node "%~dp0Build\prepare-gitflic.cjs"
set "BUILD_STATUS=%ERRORLEVEL%"
pause
exit /b %BUILD_STATUS%

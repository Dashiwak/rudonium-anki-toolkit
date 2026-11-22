@echo off
setlocal EnableExtensions DisableDelayedExpansion
where node.exe >nul 2>&1
if errorlevel 1 (
  echo Install Node.js 22.18 or later with npm, then run this command again.
  pause
  exit /b 1
)
node "%~dp0Build\prepare-release.cjs" %*
set "status=%errorlevel%"
if "%~1"=="" pause
exit /b %status%

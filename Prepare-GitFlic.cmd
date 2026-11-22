@echo off
setlocal EnableExtensions DisableDelayedExpansion
rem Redirect old Windows shortcuts to the current release command.
if not "%~1"=="" goto build
call "%~dp0Prepare-Release.cmd"
exit /b %errorlevel%
:build
rem Explicit source and destination arguments retain the legacy compiler interface.
where node.exe >nul 2>&1
if errorlevel 1 (
  echo Install Node.js 22.18 or later with npm, then run this file again.
  pause
  exit /b 1
)
where npm.cmd >nul 2>&1
if errorlevel 1 (
  echo Install npm with Node.js, then run this file again.
  pause
  exit /b 1
)
node "%~dp0Build\prepare-gitflic.cjs" %*
set "BUILD_STATUS=%ERRORLEVEL%"
pause
exit /b %BUILD_STATUS%

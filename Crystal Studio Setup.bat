@echo off
rem Crystal Studio setup: one file, double-click it once on a computer that should open crystals in
rem Illustrator straight from the order website. It gets Node.js (if missing), the latest Crystal
rem Studio (into %LOCALAPPDATA%\CrystalStudio) and the website's "Start Crystal Studio" link.
rem Run it again any time to update Crystal Studio. Nothing needs admin rights except Node.js.
setlocal
title Crystal Studio setup
echo Crystal Studio setup
echo This lets the order website open crystals in Illustrator on this computer.
echo.
set "DIR=%LOCALAPPDATA%\CrystalStudio"
set "APP=%LOCALAPPDATA%\CrystalStudio\crystalloli-main"

rem 1. Node.js: what runs Crystal Studio
where node >nul 2>nul
if errorlevel 1 (
  echo [1/3] Installing Node.js ^(Windows may ask for permission: choose Yes^)...
  winget install --id OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements
  if errorlevel 1 echo       Couldn't install it by itself. Get it from https://nodejs.org ^(the LTS button^), then run this again.
) else (
  echo [1/3] Node.js is already on this computer.
)

rem 2. Crystal Studio itself, the latest from GitHub
echo [2/3] Getting the latest Crystal Studio...
if not exist "%DIR%" mkdir "%DIR%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $z = Join-Path $env:TEMP 'crystalstudio.zip'; Invoke-WebRequest 'https://github.com/justlolipop/crystalloli/archive/refs/heads/main.zip' -OutFile $z -UseBasicParsing; Expand-Archive -Path $z -DestinationPath (Join-Path $env:LOCALAPPDATA 'CrystalStudio') -Force; Remove-Item $z"
if errorlevel 1 (
  echo       Couldn't download it. Check the internet connection, then run this again.
  echo.
  pause
  exit /b 1
)

rem 3. The website's "Start Crystal Studio" button
echo [3/3] Linking the website's "Start Crystal Studio" button...
call "%APP%\Install Crystal Studio link.bat" nopause

echo.
echo All set. On the order website: Crystal Preview, ALL, "Open in Illustrator (.ai)".
echo The first time, click "Start Crystal Studio"; when Chrome asks "Open ...?", choose Open
echo and tick "Always allow".
if not exist "%ProgramFiles%\Adobe" echo Note: Adobe Illustrator doesn't seem to be installed on this computer yet.
echo.
pause

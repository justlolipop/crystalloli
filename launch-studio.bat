@echo off
rem Started by the website's "Start Crystal Studio" button (the crystalstudio: link, set up once by
rem "Install Crystal Studio link.bat" / "Crystal Studio Setup.bat"): runs Crystal Studio in a small
rem window, unless it already runs.
cd /d "%~dp0"
rem Already running: left as it is, unless a newer Crystal Studio is online (then the running one
rem stops, and this goes on to update and start it again)
netstat -ano | findstr /r /c:":5190 .*LISTENING" >nul || goto start
if not exist "%~dp0newer.ps1" exit /b 0
if exist "%~dp0.git" exit /b 0
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0newer.ps1"
if not errorlevel 3 exit /b 0
echo A newer Crystal Studio is online: restarting it...
taskkill /FI "WINDOWTITLE eq Crystal Studio - keep this open*" /T /F >nul 2>nul
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":5190 .*LISTENING"') do taskkill /PID %%p /T /F >nul 2>nul
ping -n 3 127.0.0.1 >nul
:start
rem Node.js: on the PATH, or where its installer puts it (Chrome may still have the PATH from
rem before Node.js was installed)
set "NODE=node"
where node >nul 2>nul || set "NODE=%ProgramFiles%\nodejs\node.exe"
if not "%NODE%"=="node" if not exist "%NODE%" (echo Node.js isn't installed: run Crystal Studio Setup.bat, or get it from https://nodejs.org & pause & exit /b 1)
set "SELFCOPY="
if not exist "%~dp0.git" if /i "%~dp0"=="%LOCALAPPDATA%\CrystalStudio\crystalloli-main\" set "SELFCOPY=1"
rem One block, read whole before it runs: updating can replace this very file meanwhile.
rem The copy made by Crystal Studio Setup.bat updates itself to the latest Crystal Studio each time it
rem starts (a few seconds; skipped when offline). A folder kept with git (git pull) is left alone.
rem cmd /k: if Crystal Studio stops with an error, its window stays open to show why.
(
  if defined SELFCOPY (
    echo Updating Crystal Studio...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $z = Join-Path $env:TEMP 'crystalstudio.zip'; Invoke-WebRequest 'https://github.com/justlolipop/crystalloli/archive/refs/heads/main.zip' -OutFile $z -UseBasicParsing -TimeoutSec 30; Expand-Archive -Path $z -DestinationPath (Join-Path $env:LOCALAPPDATA 'CrystalStudio') -Force; Remove-Item $z } catch { }"
  )
  start "Crystal Studio - keep this open" /min cmd /k ""%NODE%" server.js"
  exit /b 0
)

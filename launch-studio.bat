@echo off
rem Started by the website's "Start Crystal Studio" button (the crystalstudio: link, set up once by
rem "Install Crystal Studio link.bat" / "Crystal Studio Setup.bat"): runs Crystal Studio in a small
rem window, unless it already runs.
cd /d "%~dp0"
netstat -ano | findstr /r /c:":5190 .*LISTENING" >nul && exit /b 0
rem Node.js: on the PATH, or where its installer puts it (Chrome may still have the PATH from
rem before Node.js was installed)
set "NODE=node"
where node >nul 2>nul || set "NODE=%ProgramFiles%\nodejs\node.exe"
if not "%NODE%"=="node" if not exist "%NODE%" (echo Node.js isn't installed: run Crystal Studio Setup.bat, or get it from https://nodejs.org & pause & exit /b 1)
start "Crystal Studio - keep this open" /min "%NODE%" server.js

@echo off
rem Started by the website's "Start Crystal Studio" button (the crystalstudio: link, set up once by
rem "Install Crystal Studio link.bat"): runs Crystal Studio in a small window, unless it already runs.
cd /d "%~dp0"
netstat -ano | findstr /r /c:":5190 .*LISTENING" >nul && exit /b 0
where node >nul 2>nul || (echo Node.js isn't installed: get it from https://nodejs.org ^(LTS^). & pause & exit /b 1)
start "Crystal Studio - keep this open" /min cmd /c "node server.js"

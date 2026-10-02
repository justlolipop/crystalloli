@echo off
rem Crystal Studio: starts the small local program, then opens the page in your browser.
rem Keep this window open while you work; close it to stop.
cd /d "%~dp0"
start "" http://localhost:5190
node server.js
pause

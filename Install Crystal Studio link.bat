@echo off
rem Run once (double-click) on a PC that should open crystals in Illustrator straight from the website.
rem Afterwards, when Crystal Studio isn't running, the website's "Start Crystal Studio" button starts
rem it: Chrome asks first ("Open ...?"; tick "Always allow"). Only for this Windows user, nothing is
rem copied anywhere. Keep this folder where it is (the link points to it). To undo:
rem   reg delete HKCU\Software\Classes\crystalstudio /f
set "LAUNCH=%~dp0launch-studio.bat"
reg add "HKCU\Software\Classes\crystalstudio" /ve /d "URL:Crystal Studio" /f >nul
reg add "HKCU\Software\Classes\crystalstudio" /v "URL Protocol" /d "" /f >nul
reg add "HKCU\Software\Classes\crystalstudio\shell\open\command" /ve /d "\"%ComSpec%\" /c \"\"%LAUNCH%\"\"" /f >nul
echo.
echo Done. On this PC the website's "Start Crystal Studio" button now starts Crystal Studio.
where node >nul 2>nul || echo Still needed: Node.js from https://nodejs.org (the LTS one).
echo.
pause

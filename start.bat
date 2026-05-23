@echo off
cd /d "%~dp0"
echo [Triad Engine] Launching...
npx electron desktop/main.js
pause

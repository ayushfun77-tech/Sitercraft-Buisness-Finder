@echo off
cd /d "%~dp0"
start "SiteCraft Prospect AI" powershell -NoExit -ExecutionPolicy Bypass -File "%~dp0start.ps1"
timeout /t 3 /nobreak >nul
start "" http://localhost:3000
